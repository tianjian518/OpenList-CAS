/**
 * 139 云盘 CAS 播放
 *
 * 原始实现。负责把「CAS 占位文件」变成「可播放的直链」。
 *
 * 完整链路：
 *   ① 读取 .cas 文件内容 → base64 解码 → 得到 CasMeta
 *   ② 在临时目录用 SHA256 秒传恢复真实文件（零字节传输）
 *   ③ 取该文件的下载直链
 *   ④ 返回直链给播放器
 *   ⑤ 延时清理临时副本（配合惰性清扫与定时清扫兜底）
 */

import { CasMeta, decodeCas, deriveRealName, extAllowed } from "./format"
import {
  ensureTempDir,
  makeTempPrefix,
  restoreFromCas,
  safeDelete,
  sweepTempFiles,
} from "./restore"
import { Yun139ApiClient } from "../util"

/** 播放直链结果 */
export interface CasPlayLink {
  /** 可播放的直链 */
  url: string
  /** 真实文件字节数，供播放器显示进度 */
  size: number
  /** 真实文件名 */
  name: string
  /** 请求直链时需要携带的头 */
  headers?: Record<string, string>
  /** 本次使用的临时目录 ID（供驱动缓存复用，省一次列目录往返） */
  tempDirId?: string
}

/** 播放失败的错误（带用户可读信息） */
export class CasPlayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CasPlayError"
  }
}

/** 默认允许播放的扩展名 */
const DEFAULT_VIDEO_EXT =
  "mp4,mkv,ts,m2ts,avi,mov,wmv,flv,webm,rmvb,rm,m4v,mpg,mpeg,3gp"

/**
 * 判断给定文件是否应按 CAS 播放流程处理。
 *
 * @param name 文件名
 * @param allowExt 白名单；空表示用默认视频扩展名
 */
export function shouldHandleCas(name: string, allowExt?: string): boolean {
  if (!/\.cas$/i.test(name)) return false
  const list = allowExt && allowExt.trim() ? allowExt : DEFAULT_VIDEO_EXT
  // CAS 文件名形如 movie.mp4.cas，去掉 .cas 再判断
  const inner = name.replace(/\.cas$/i, "")
  return extAllowed(inner, list)
}

/**
 * 读取 139 上的文件内容为文本。
 * CAS 文件只有几 KB，直接全量读取。
 */
export async function readCasContent(
  client: Yun139ApiClient,
  fileId: string,
): Promise<string> {
  const url = await client.getDownloadUrl(fileId)
  const res = await fetch(url, {
    headers: {
      Referer: "https://yun.139.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
  })
  if (!res.ok) {
    throw new CasPlayError(`读取 CAS 文件失败（HTTP ${res.status}）`)
  }
  const text = await res.text()
  if (text.length > 64 * 1024) {
    throw new CasPlayError("CAS 文件体积异常，疑似不是有效的占位文件")
  }
  return text
}

/** 解析 CAS 文本为元数据 */
export function parseCasMeta(content: string): CasMeta {
  const meta = decodeCas(content)
  if (!meta.sha256) {
    throw new CasPlayError(
      "该 CAS 文件未记录 SHA256，无法秒传恢复（可能是旧版工具生成）",
    )
  }
  return meta
}

export interface ResolveOpts {
  /** 139 客户端 */
  client: Yun139ApiClient
  /** 根目录 ID（个人新版为 "/"，家庭/群组为 catalogID） */
  rootId: string
  /** CAS 文件的 139 fileId */
  casFileId: string
  /** CAS 文件名（如 movie.mp4.cas） */
  casName: string
  /** 是否播放后自动清理临时副本，默认 true */
  autoCleanup?: boolean
  /** 延时清理的等待毫秒数，默认 120 秒 */
  cleanupDelayMs?: number
  /**
   * 已知的临时目录 ID（由驱动缓存注入）。
   *
   * 播放是延迟敏感路径，Workers 的子请求/CPU 均有硬限制；
   * 传入后可省掉一次"列根目录找 TEMP"的往返，降低超限（503）风险。
   */
  tempDirId?: string
  /**
   * 是否在播放前顺带做一次惰性清扫，默认 false。
   *
   * ⚠️ 默认**关闭**：清扫需要"列 TEMP 目录 + 逐个删除"，在播放热路径上
   * 会显著增加子请求数与耗时，正是 503 超限的主要来源之一。
   * 兜底清理请交给 worker 的 `scheduled` 定时任务（见 worker.ts）。
   */
  sweepOnPlay?: boolean
}

/**
 * 核心方法：由 CAS 文件换取播放直链。
 *
 * 流程：读 CAS 内容 → 解析元数据 → 秒传恢复 → 取直链 → 安排清理
 *
 * 出错时抛出带 `[step=...]` 前缀的 `CasPlayError`，便于在日志中快速
 * 定位失败环节（read / tempdir / restore / link）。
 */
export async function resolveCasPlayLink(
  opts: ResolveOpts,
): Promise<CasPlayLink> {
  const { client, casFileId, casName, rootId } = opts
  const autoCleanup = opts.autoCleanup !== false

  // ① 惰性清理（仅当显式开启；默认关闭以免拖慢播放）
  if (opts.sweepOnPlay === true) {
    await sweepTempFiles(client, rootId)
  }

  // ② 读取并解析 CAS
  let step = "read"
  let content = ""
  try {
    content = await readCasContent(client, casFileId)
  } catch (e) {
    throw new CasPlayError(
      `[step=${step}] ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const meta = parseCasMeta(content)
  const realName = deriveRealName(casName, meta.name)

  // ③ 秒传恢复到临时目录（带时间戳前缀，供后续清理识别）
  step = "tempdir"
  let tempDirId = ""
  try {
    tempDirId = await ensureTempDir(client, rootId, opts.tempDirId)
  } catch (e) {
    throw new CasPlayError(
      `[step=${step}] ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  const tempPrefix = makeTempPrefix()

  let restored: { fileId: string; fileName: string }
  try {
    restored = await restoreFromCas(client, tempDirId, casName, meta, tempPrefix)
  } catch (e) {
    throw new CasPlayError(
      `[step=restore] ${
        e instanceof Error ? e.message : "秒传恢复失败，无法播放该 CAS 文件"
      }`,
    )
  }

  // ④ 取直链
  let url: string
  try {
    url = await client.getDownloadUrl(restored.fileId)
  } catch (e) {
    // 取直链失败说明这个副本没用了，立即清掉避免堆积
    await safeDelete(client, restored.fileId)
    throw new CasPlayError(
      `[step=link fileId=${restored.fileId.slice(0, 12)}] 未能取得播放直链：${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  // ⑤ 安排清理
  if (autoCleanup) {
    scheduleCleanup(client, restored.fileId, opts.cleanupDelayMs ?? 120_000)
  }

  return {
    url,
    size: meta.size,
    name: realName,
    tempDirId,
    headers: {
      Referer: "https://yun.139.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
  }
}

/**
 * 安排临时副本清理。
 *
 * ⚠️ 可靠性说明（重要）：
 *
 * 这里原本依赖 `ctx.waitUntil` 在响应返回后延时删除，但该机制在
 * Cloudflare Workers 上**不足以**完成这件事：
 *   - 请求结束后 isolate 可能随时被回收，`waitUntil` 只保证约 30 秒；
 *   - 而 `cleanupDelayMs` 默认 120 秒，**远超过这个寿命**；
 *   - 加上没有任何地方向 `globalThis.__cas_ctx__` 赋值，
 *     `ctx` 恒为 `undefined`，任务会被直接丢弃。
 *
 * 结果就是：所有临时副本**永远留在 TEMP 里**。
 *
 * 因此这里只把它当作"尽力而为"的快路径（延迟较短时有意义），
 * 真正的兜底由 worker 的 `scheduled` 定时任务调用
 * `sweepTempFilesAll()` 完成 —— 那条路径不受请求生命周期约束。
 */
function scheduleCleanup(
  client: Yun139ApiClient,
  fileId: string,
  delayMs: number,
): void {
  const task = (async () => {
    await new Promise((r) => setTimeout(r, delayMs))
    await safeDelete(client, fileId)
  })()

  // 尝试挂到 Workers 的 waitUntil（若可用）
  const ctx = (globalThis as any).__cas_ctx__
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(task)
  } else {
    // 无 waitUntil：不能让未处理的 rejection 逃逸，也不能假装成功。
    // 真正的清理依赖定时任务兜底。
    task.catch(() => {})
  }
}
