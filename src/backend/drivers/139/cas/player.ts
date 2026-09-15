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
 *   ⑤ 延时清理临时副本（配合惰性清扫兜底）
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
}

/**
 * 核心方法：由 CAS 文件换取播放直链。
 *
 * 流程：读 CAS 内容 → 解析元数据 → 秒传恢复 → 取直链 → 安排清理
 */
export async function resolveCasPlayLink(
  opts: ResolveOpts,
): Promise<CasPlayLink> {
  const { client, casFileId, casName, rootId } = opts
  const autoCleanup = opts.autoCleanup !== false

  // ① 惰性清理（顺手清掉过期临时副本）
  await sweepTempFiles(client, rootId)

  // ② 读取并解析 CAS
  const content = await readCasContent(client, casFileId)
  const meta = parseCasMeta(content)
  const realName = deriveRealName(casName, meta.name)

  // ③ 秒传恢复到临时目录（带时间戳前缀，供惰性清理识别）
  const tempDirId = await ensureTempDir(client, rootId)
  const tempPrefix = makeTempPrefix()

  let restored: { fileId: string; fileName: string }
  try {
    restored = await restoreFromCas(client, tempDirId, casName, meta, tempPrefix)
  } catch (e) {
    throw new CasPlayError(
      e instanceof Error ? e.message : "秒传恢复失败，无法播放该 CAS 文件",
    )
  }

  // ④ 取直链
  let url: string
  try {
    url = await client.getDownloadUrl(restored.fileId)
  } catch (e) {
    await safeDelete(client, restored.fileId)
    throw new CasPlayError(
      `未能取得播放直链：${e instanceof Error ? e.message : String(e)}`,
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
 * Cloudflare Workers 允许在响应返回后继续执行一小段时间（ctx.waitUntil），
 * 这里借它做延时删除。若运行时没有 waitUntil，则只依赖惰性清扫。
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
    task.catch(() => {})
  }
}
