/**
 * CAS 元数据编解码
 *
 * 原始实现。CAS 是一种"内容寻址占位文件"：
 * 文件本体不存内容，只存一段 base64 编码的 JSON 元数据，
 * 描述真实文件的名字、大小与各种哈希。播放/下载时，
 * 用元数据里的 SHA256 向移动云盘发起"秒传"，换取真实文件句柄。
 *
 * 文件命名约定：`<真实文件名>.<扩展名>.cas`
 * 例如 `movie.mp4` → `movie.mp4.cas`
 */

export const CAS_EXT = ".cas"

/** CAS 元数据（解码后） */
export interface CasMeta {
  /** 来源供应商标识，139 场景可留空 */
  provider?: string
  /** 真实文件名，如 `movie.mp4` */
  name: string
  /** 真实文件字节数 */
  size: number
  /** 整文件 MD5（十六进制，小写） */
  md5?: string
  /** 分片 MD5（大文件时用于秒传校验） */
  sliceMd5?: string
  /** SHA1（115 等盘需要） */
  sha1?: string
  /** 预置 ID（115 等盘需要） */
  preId?: string
  /** SHA256（139 秒传的必需字段） */
  sha256?: string
  /** 源文件所在目录 ID（部分工具会写入，用于定位来源） */
  parentFileId?: string
  /** CAS 生成时间（秒级字符串，来自载荷的 create_time） */
  createTime?: string
}

/** CAS JSON 载荷（落盘格式） */
interface CasPayload {
  provider?: string
  name: string
  size: number
  md5?: string
  sliceMd5?: string
  sha1?: string
  preID?: string
  sha256?: string
  parentFileId?: string
  create_time?: string
}

/** 判断文件名是否为 CAS 占位文件 */
export function isCasName(name: string): boolean {
  return name.toLowerCase().endsWith(CAS_EXT)
}

/** 由真实文件名推导 CAS 文件名 */
export function toCasName(realName: string): string {
  return realName + CAS_EXT
}

/**
 * 由 CAS 文件名推导真实文件名。
 *
 * `movie.mp4.cas` → `movie.mp4`
 * 若 CAS 文件名退化为 `movie.cas`，则回退用元数据里的 name。
 */
export function deriveRealName(casName: string, metaName?: string): string {
  const base = casName.slice(0, casName.length - CAS_EXT.length)
  if (base.includes(".")) {
    return base
  }
  return metaName && metaName.includes(".") ? metaName : base
}

/**
 * 将元数据编码为 CAS 文件内容。
 * 格式：base64(UTF-8 JSON)
 */
export function encodeCas(meta: CasMeta): string {
  if (!meta.name) throw new Error("CAS 元数据缺少 name")
  const payload: CasPayload = {
    provider: meta.provider,
    name: meta.name,
    size: meta.size,
    md5: meta.md5,
    sliceMd5: meta.sliceMd5 || meta.md5,
    sha1: meta.sha1,
    preID: meta.preId,
    sha256: meta.sha256,
    create_time: String(Math.floor(Date.now() / 1000)),
  }
  return base64EncodeUtf8(JSON.stringify(payload))
}

/**
 * 解析 CAS 文件内容为元数据。
 *
 * 容错处理：部分实现可能省略 padding 或含首尾空白，这里统一修正。
 */
export function decodeCas(content: string | ArrayBuffer | Uint8Array): CasMeta {
  const raw =
    typeof content === "string"
      ? content
      : utf8Decode(content instanceof Uint8Array ? content : new Uint8Array(content))

  const trimmed = raw.trim()
  if (!trimmed) throw new Error("CAS 文件为空")

  // 兼容缺失 padding 的 base64
  const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4)

  let decoded: string
  try {
    decoded = base64DecodeUtf8(padded)
  } catch {
    throw new Error("CAS 内容不是合法的 base64")
  }

  let payload: CasPayload
  try {
    payload = JSON.parse(decoded) as CasPayload
  } catch {
    throw new Error("CAS 内容不是合法的 JSON")
  }

  if (!payload.name || typeof payload.name !== "string") {
    throw new Error("CAS 元数据缺少 name 字段")
  }
  if (typeof payload.size !== "number" || payload.size < 0) {
    throw new Error("CAS 元数据 size 字段非法")
  }
  if (!payload.md5 && !payload.sha256 && !payload.sha1) {
    throw new Error("CAS 元数据缺少任何哈希值")
  }

  return {
    provider: payload.provider,
    name: payload.name,
    size: payload.size,
    md5: payload.md5,
    sliceMd5: payload.sliceMd5 || payload.md5,
    sha1: payload.sha1,
    preId: payload.preID,
    sha256: payload.sha256,
    parentFileId: payload.parentFileId,
    createTime: payload.create_time,
  }
}

/**
 * 扩展名白名单校验。
 *
 * @param name 文件名
 * @param allowlist 逗号分隔的扩展名，空串或 `*` 表示全部允许
 */
export function extAllowed(name: string, allowlist: string): boolean {
  const list = normalizeAllowlist(allowlist)
  if (!list || list === "*") return true
  const idx = name.lastIndexOf(".")
  if (idx < 0) return false
  const ext = name.slice(idx + 1).toLowerCase()
  return list.split(",").includes(ext)
}

/** 规范化白名单字符串 */
export function normalizeAllowlist(allowlist: string): string {
  const parts = (allowlist || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
  if (parts.includes("*")) return "*"
  return Array.from(new Set(parts)).join(",")
}

/* ---------------- base64 与 UTF-8 互转 ---------------- */

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes)
}

function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

function base64EncodeUtf8(str: string): string {
  const bytes = utf8Encode(str)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    )
  }
  return btoa(binary)
}

function base64DecodeUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return utf8Decode(bytes)
}
