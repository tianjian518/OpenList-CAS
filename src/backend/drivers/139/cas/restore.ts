/**
 * 139 云盘 CAS 秒传恢复
 *
 * 原始实现。核心思路：CAS 元数据里存着真实文件的 SHA256，
 * 只要云端存在同 hash 的内容，就能通过 `/file/create` 接口
 * "凭空"创建出该文件（秒传），无需上传任何字节。
 *
 * 这正是 CAS 能在 Serverless 上播放的原因 —— 全程零字节传输。
 */

import { CasMeta, deriveRealName } from "./format"
import { Yun139ApiClient } from "../util"

/** 秒传结果 */
export interface RapidResult {
  /** 云端已存在同名同 hash 文件 */
  exist: boolean
  /** 秒传命中 */
  rapid: boolean
  /** 创建出的文件 ID */
  fileId: string
  /** 实际落盘文件名（可能被自动改名） */
  fileName: string
  /**
   * 云端返回的分片信息。
   *
   * 对齐 Go `PersonalUploadResp.Data.PartInfos`。**非空即代表秒传未命中**：
   * 云端要求客户端真正上传这些分片，说明它并不持有该 hash 对应的内容。
   * 调用方（`restoreFromCas`）据此判定失败，绝不能把这种情况当成成功。
   */
  partInfos: Array<{ partNumber?: number; partSize?: number }>
}

/** 临时副本命名前缀，便于识别与批量清理 */
export const CAS_TEMP_PREFIX = "TEMP_139CAS_"

/** 临时目录名 */
export const CAS_TEMP_DIR = "TEMP"

/**
 * 秒传分片大小。
 *
 * **对齐 Go `drivers/139/driver.go:Yun139.getPartSize`**：
 *
 *   func (d *Yun139) getPartSize(size int64) int64 {
 *     if d.CustomUploadPartSize != 0 { return d.CustomUploadPartSize }
 *     if size/utils.GB > 30 { return 512 * utils.MB }   // >30GB → 512MB
 *     return 100 * utils.MB                              // 默认 100MB
 *   }
 *
 * ⚠️ 这里此前的值是 10MB，与 Go 不一致，会直接导致秒传失败：
 * 分片数 = ceil(size / partSize)，而云端对 `partInfos` 数组长度有上限
 * （见 MAX_PART_INFOS）。1.57GB 的文件按 10MB 分片要 158 片，
 * 超过上限后被截断成 100 片 × 10MB = 1GB —— **声明的总大小与实际文件
 * 大小不符**，云端会返回「需要真正上传」的 partInfos（即秒传未命中），
 * 于是恢复失败或恢复出错误内容。
 * 按 100MB 分片只需 16 片，与 Go 行为完全一致。
 */
const SLICE_SIZE = 100 * 1024 * 1024

/** 大小超过该阈值（30GB）时改用 512MB 分片，对齐 Go `getPartSize` */
const LARGE_FILE_THRESHOLD = 30 * 1024 * 1024 * 1024
const LARGE_SLICE_SIZE = 512 * 1024 * 1024

/** 单次请求最多声明的分片数（云端限制） */
const MAX_PART_INFOS = 100

/**
 * 计算秒传所需的分片信息，**对齐 Go `Yun139.personalPartInfos` +
 * `getPartSize`**：
 *
 *   partSize := d.getPartSize(size)
 *   part := 1
 *   if size > partSize { part = (size + partSize - 1) / partSize }
 *   for i := 0; i < part; i++ {
 *     start := i * partSize
 *     byteSize := min(size-start, partSize)
 *     partInfos = append(partInfos, PartInfo{PartNumber: i + 1, PartSize: byteSize})
 *   }
 *
 * 注意 `partNumber` 从 1 开始（Go 写的是 `i + 1`）。
 */
export function buildPartInfos(
  size: number,
): Array<{ partNumber: number; partSize: number }> {
  const partSize = size > LARGE_FILE_THRESHOLD ? LARGE_SLICE_SIZE : SLICE_SIZE
  const count = size > partSize ? Math.ceil(size / partSize) : 1
  const list: Array<{ partNumber: number; partSize: number }> = []
  for (let i = 0; i < count && i < MAX_PART_INFOS; i++) {
    const start = i * partSize
    const remain = size - start
    list.push({
      partNumber: i + 1,
      partSize: remain > partSize ? partSize : remain,
    })
  }
  return list
}

/**
 * 用 SHA256 秒传创建文件（零字节传输）。
 *
 * @param client 139 API 客户端
 * @param parentFileId 目标目录 ID
 * @param name 目标文件名
 * @param size 文件字节数
 * @param sha256 文件的 SHA256（64 位十六进制）
 */
export async function rapidCreate(
  client: Yun139ApiClient,
  parentFileId: string,
  name: string,
  size: number,
  sha256: string,
): Promise<RapidResult> {
  if (sha256.length !== 64) {
    throw new Error(`SHA256 长度非法（${sha256.length}，应为 64）`)
  }

  const res = await client.request<any>(
    "/file/create",
    {
      contentHash: sha256.toUpperCase(),
      contentHashAlgorithm: "SHA256",
      contentType: "application/octet-stream",
      parallelUpload: false,
      partInfos: buildPartInfos(size),
      size,
      parentFileId,
      name,
      type: "file",
      fileRenameMode: "auto_rename",
    },
    true,
  )

  const d = res?.data ?? {}
  return {
    exist: Boolean(d.exist),
    rapid: Boolean(d.rapidUpload),
    fileId: String(d.fileId ?? ""),
    fileName: String(d.fileName ?? name),
    // 对齐 Go `resp.Data.PartInfos`：非空表示秒传未命中、需真上传
    partInfos: Array.isArray(d.partInfos) ? d.partInfos : [],
  }
}

/**
 * 确保临时目录存在，返回其 ID。
 *
 * 临时副本集中放在一个目录下，便于统一清理。
 *
 * @param rootId 根目录 ID（由驱动提供，个人新版为 "/"，家庭/群组为 catalogID）
 * @param knownId 已知的临时目录 ID。传入时直接返回，**省掉一次列根目录的请求**。
 *                播放路径对此很敏感：Workers 等平台有子请求/CPU 硬限制，
 *                多一次往返就可能让整个播放请求超限失败。
 */
export async function ensureTempDir(
  client: Yun139ApiClient,
  rootId: string,
  knownId?: string,
): Promise<string> {
  if (knownId) return knownId

  const root = rootId

  // 先找
  try {
    const { folders } = await client.listFiles(root)
    const hit = folders.find((f) => f.catalogName === CAS_TEMP_DIR)
    if (hit) return hit.catalogID
  } catch {
    // 找不到就创建
  }

  // 再建
  const res = await client.request<any>(
    "/file/create",
    {
      parentFileId: root,
      name: CAS_TEMP_DIR,
      description: "",
      type: "folder",
      fileRenameMode: "force_rename",
    },
    true,
  )
  const id = String(res?.data?.fileId ?? "")
  if (!id) throw new Error(`创建临时目录失败：${CAS_TEMP_DIR}`)
  return id
}

/**
 * 从 CAS 元数据恢复真实文件到云端。
 *
 * @param tempPrefix 传入前缀表示创建临时副本（播放场景），否则恢复为正式文件
 */
export async function restoreFromCas(
  client: Yun139ApiClient,
  parentFileId: string,
  casName: string,
  meta: CasMeta,
  tempPrefix?: string,
): Promise<{ fileId: string; fileName: string }> {
  const realName = deriveRealName(casName, meta.name)
  const target = tempPrefix ? `${tempPrefix}${realName}` : realName

  if (!meta.sha256) {
    throw new Error("该 CAS 文件未记录 SHA256，无法秒传恢复（可能是旧版工具生成）")
  }

  // 秒传只需要 hash 与大小，但目标目录必须是**当前有效**的目录。
  //
  // 实测结论：把副本创建到 CAS 元数据里记录的源目录会失败
  // （`04000010 资源不存在`，源目录可能已被删除或改名），
  // 而创建到调用方指定的临时目录必定成功。因此这里只用一个目标目录，
  // 失败则说明内容确实不在云端。
  const r = await rapidCreate(client, parentFileId, target, meta.size, meta.sha256)

  // **对齐 Go `restoreCAS` 的判定**：
  //
  //   if !resp.Data.Exist && !resp.Data.RapidUpload && resp.Data.PartInfos != nil {
  //     return nil, fmt.Errorf("cas restore failed: source file data does not exist in cloud")
  //   }
  //
  // 语义：只有 `exist` 或 `rapidUpload` 为真才算秒传命中。
  // 若云端要求逐片上传（返回了 partInfos），说明它**没有**这份内容，
  // 必须报错 —— 否则会把 partInfos 里的分片信息当成"已创建的文件"，
  // 后续用错误的 fileId 取直链，拿到的是别的东西（此前实测拿到的正是
  // 540 字节的 `.cas` 占位文件本身，播放器解析失败 → 无法播放）。
  if (r.exist || r.rapid) {
    return { fileId: r.fileId, fileName: r.fileName || target }
  }

  if (r.partInfos && r.partInfos.length > 0) {
    throw new Error(
      "秒传未命中：云端不存在该文件内容（可能源文件已被删除或改动）。",
    )
  }

  throw new Error(
    "秒传未命中：云端未返回 exist/rapidUpload 标记，且未给出分片信息。",
  )
}

/**
 * 删除文件（用于清理临时副本）。
 *
 * 关键：个人盘新版的删除接口是 `/recyclebin/batchTrash`（移入回收站），
 * 而非 `/file/delete` —— 后者会返回 404 + "认证失败"。
 *
 * 失败不抛错 —— 留给惰性清理兜底。
 */
export async function safeDelete(
  client: Yun139ApiClient,
  fileId: string,
): Promise<void> {
  if (!fileId) return
  try {
    await client.request(
      "/recyclebin/batchTrash",
      { fileIds: [fileId] },
      true,
    )
  } catch {
    // 忽略
  }
}

/**
 * 惰性清理：删除临时目录中遗留的过期副本。
 *
 * Serverless 无法可靠运行后台定时任务，因此采用"播放前顺手清理"的策略。
 * 每次成功播放后也会尝试延时删除（见 player.ts）。
 *
 * @param rootId 根目录 ID（由驱动提供）
 * @returns 清理掉的文件数量
 */
export async function sweepTempFiles(
  client: Yun139ApiClient,
  rootId: string,
  olderThanMs = 30 * 60 * 1000,
): Promise<number> {
  let removed = 0
  try {
    const tempDirId = await ensureTempDir(client, rootId)
    const { files } = await client.listFiles(tempDirId)
    const now = Date.now()

    for (const f of files) {
      const name = f.contentName || ""
      if (!name.startsWith(CAS_TEMP_PREFIX)) continue

      // 文件名里嵌了时间戳：TEMP_139CAS_<ms>_<rand>_<原名>
      const rest = name.slice(CAS_TEMP_PREFIX.length)
      const ts = Number(rest.split("_")[0])
      if (!Number.isFinite(ts)) continue
      if (now - ts < olderThanMs) continue

      if (f.contentID) {
        await safeDelete(client, f.contentID)
        removed++
      }
    }
  } catch {
    // 清理失败不影响播放
  }
  return removed
}

/** 生成临时副本前缀（带时间戳，供后续清理识别） */
export function makeTempPrefix(): string {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return `${CAS_TEMP_PREFIX}${stamp}_`
}

/**
 * 清理临时目录中的**全部**遗留副本（不看年龄）。
 *
 * 与 `sweepTempFiles` 的区别：
 *   - `sweepTempFiles` 只清"超过 N 分钟"的，用于播放前顺手清理，
 *     避免误删正在被播放器读取的副本；
 *   - 本函数用于**定时任务**场景：此时不会有任何副本正在使用
 *     （播放请求是短暂的，且副本寿命以分钟计），可以放心全清。
 *
 * Serverless 环境没有常驻进程，`ctx.waitUntil` 又只有约 30 秒寿命，
 * 因此"播放后延时删除"在 Workers 上不可靠 —— 定时触发才是唯一
 * 能稳定兜底的清理时机。
 *
 * @param client 139 客户端
 * @param rootId 根目录 ID（用于定位 TEMP 目录）
 * @param maxCount 单次最多清理的文件数，防止一次请求超时/超限
 * @returns 实际清理掉的文件数量
 */
export async function sweepTempFilesAll(
  client: Yun139ApiClient,
  rootId: string,
  maxCount = 200,
): Promise<number> {
  let removed = 0
  try {
    // 注意：这里**必须**走 ensureTempDir 的"查找"分支而非缓存 ID，
    // 否则定时任务里拿不到 tempDirId（没有请求上下文可复用）。
    const tempDirId = await ensureTempDir(client, rootId)
    const { files } = await client.listFiles(tempDirId)

    let handled = 0
    for (const f of files) {
      if (handled >= maxCount) break

      const name = f.contentName || ""
      // ⚠️ 只清自己前缀的文件。
      // TEMP 目录里理论上只有本驱动产生的副本，但为绝对安全，
      // 这里严格匹配 `TEMP_139CAS_` 前缀：即使有人往 TEMP 放了
      // 别的文件（或 NAS 版将来也用同名目录），也绝不会被误删。
      if (!name.startsWith(CAS_TEMP_PREFIX)) continue

      if (f.contentID) {
        await safeDelete(client, f.contentID)
        removed++
        handled++
      }
    }
  } catch {
    // 定时清理失败不影响任何用户请求
  }
  return removed
}
