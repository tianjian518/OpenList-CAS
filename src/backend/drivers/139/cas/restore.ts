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
}

/** 临时副本命名前缀，便于识别与批量清理 */
export const CAS_TEMP_PREFIX = "TEMP_139CAS_"

/** 临时目录名 */
export const CAS_TEMP_DIR = "TEMP"

/** 秒传分片大小（与云端约定一致） */
const SLICE_SIZE = 10 * 1024 * 1024

/** 单次请求最多声明的分片数（云端限制） */
const MAX_PART_INFOS = 100

/**
 * 计算秒传所需的分片信息。
 *
 * 注意：这里只声明分片大小，不参与实际传输。
 */
export function buildPartInfos(
  size: number,
): Array<{ partNumber: number; partSize: number }> {
  const partSize = size <= SLICE_SIZE ? size : SLICE_SIZE
  const count = size > 0 ? Math.ceil(size / partSize) : 1
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

  const res = await client.request<any>("/file/create", {
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
  })

  const d = res?.data ?? {}
  return {
    exist: Boolean(d.exist),
    rapid: Boolean(d.rapidUpload),
    fileId: String(d.fileId ?? ""),
    fileName: String(d.fileName ?? name),
  }
}

/**
 * 确保临时目录存在，返回其 ID。
 *
 * 临时副本集中放在一个目录下，便于统一清理。
 */
/**
 * 确保临时目录存在，返回其 ID。
 *
 * 临时副本集中放在一个目录下，便于统一清理。
 *
 * @param rootId 根目录 ID（由驱动提供，个人新版为 "/"，家庭/群组为 catalogID）
 */
export async function ensureTempDir(
  client: Yun139ApiClient,
  rootId: string,
): Promise<string> {
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
  const res = await client.request<any>("/file/create", {
    parentFileId: root,
    name: CAS_TEMP_DIR,
    description: "",
    type: "folder",
    fileRenameMode: "force_rename",
  })
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

  const r = await rapidCreate(
    client,
    parentFileId,
    target,
    meta.size,
    meta.sha256,
  )

  if (!r.exist && !r.rapid) {
    throw new Error(
      "秒传未命中：云端不存在该文件内容。请确认对应的真实文件仍在云盘上。",
    )
  }

  return { fileId: r.fileId, fileName: r.fileName || target }
}

/**
 * 删除文件（用于清理临时副本）。
 *
 * 失败不抛错 —— 留给惰性清理兜底。
 */
export async function safeDelete(
  client: Yun139ApiClient,
  fileId: string,
): Promise<void> {
  if (!fileId) return
  try {
    await client.request("/file/delete", { fileIds: [fileId] })
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
