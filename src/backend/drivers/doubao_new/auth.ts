/**
 * 豆包新驱动（doubao_new）的鉴权实现
 *
 * ## 背景
 * 豆包网盘的在线预览走飞书（Lark）的 space API。飞书对「非浏览器」调用
 * 施加了 **DPoP（Demonstrating Proof-of-Possession）** 校验：除了
 * `Authorization: DPoP <access_token>`，每个请求还必须在 `dpop` 头里带一个
 * 用私钥现签的 JWT，声明「我是这个公钥的持有者」，且 `htu` 必须精确等于
 * 目标 URL、`htm` 等于方法名 —— 服务端会重算签名并比对。
 *
 * 因此仅靠从 Cookie 里扒下来的静态 dpop 撑不了多久（它是短时效 JWT），
 * 正确做法是：用 `dpop_key_secret` 解密 Cookie 里的 `feishu_dpop_keypair`，
 * 拿到 EC P-256 私钥后**每次请求自己签**，并通过 biz_auth 换新 token。
 *
 * ## 与 Go 版的对应关系
 * 本文件对应 Go 版 drivers/doubao_new 的 auth 部分。
 */

/** DPoP JWT 的默认有效期（秒）。飞书侧要求很短，15 秒足够一次请求 */
const defaultExpiresIn = 15

/** 一次能放进 JWT 的 base64url 编码 */
export function b64url(bytes: string | ArrayBuffer | Uint8Array): string {
  let u8: Uint8Array
  if (typeof bytes === "string") {
    u8 = new TextEncoder().encode(bytes)
  } else if (bytes instanceof ArrayBuffer) {
    u8 = new Uint8Array(bytes)
  } else {
    u8 = bytes
  }
  let s = ""
  // 逐字节拼接再 btoa：避免 String.fromCharCode.apply 在大数据上爆栈
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** base64url 解码为字节 */
export function b64urlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4) s += "="
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 宽松 base64 解码：依次尝试标准/无填充/URL-safe 变体。
 * 用户从浏览器复制的密钥串常带换行、空格，或 URL-safe 字符，单一格式会解错。
 */
export function decodeBase64Loose(raw: string): Uint8Array {
  const cleaned = raw.replace(/[\n\r\t ]/g, "")
  const variants = [
    cleaned,
    cleaned.replace(/=+$/, ""),
    cleaned.replace(/\+/g, "-").replace(/\//g, "_"),
    cleaned.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ]
  for (const v of variants) {
    try {
      let s = v.replace(/-/g, "+").replace(/_/g, "/")
      while (s.length % 4) s += "="
      const bin = atob(s)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch {
      // 尝试下一个变体
    }
  }
  throw new Error("invalid base64")
}

/** 解析 JWT 的 payload 段（**不校验签名**，仅用于读 exp 等声明） */
export function parseJWTPayload(token: string): any {
  const t = trimTokenScheme(token)
  const parts = t.split(".")
  if (parts.length < 2) throw new Error("invalid JWT format")
  const payloadBytes = b64urlDecode(parts[1])
  const json = new TextDecoder().decode(payloadBytes)
  return JSON.parse(json)
}

/**
 * 去掉 token 的 scheme 前缀。
 * Cookie 里存的可能是 `DPoP xxx` / `Bearer xxx`，也可能就是裸 token。
 */
export function trimTokenScheme(token: string): string {
  const t = (token || "").trim()
  const i = t.indexOf(" ")
  if (i > 0) {
    const scheme = t.slice(0, i).trim().toLowerCase()
    if (scheme === "bearer" || scheme === "dpop") return t.slice(i + 1).trim()
  }
  return t
}

/**
 * 把 ECDSA 签名统一成 JWS 要求的 64 字节裸格式（r||s）。
 *
 * WebCrypto 的 `ECDSA.sign` 在部分实现（如 Node/Workers 的某些版本）返回
 * DER 编码，而 JWS 规范要求固定 64 字节。这里自动识别并转换，
 * 否则产出的 dpop 会被服务端判为无效签名。
 */
export function normalizeEcdsaSignature(sig: Uint8Array): Uint8Array {
  if (sig.length === 64) return sig
  if (sig.length > 0 && sig[0] === 0x30) return derToRaw(sig)
  throw new Error(`unexpected ECDSA signature length: ${sig.length}`)
}

/** DER（SEQUENCE{INTEGER r, INTEGER s}）→ 64 字节裸签名 */
export function derToRaw(der: Uint8Array): Uint8Array {
  let offset = 0
  if (der[offset++] !== 0x30) throw new Error("invalid DER signature")
  offset++ // 跳过总长度字节
  if (der[offset++] !== 0x02) throw new Error("invalid DER signature (r)")
  const rLen = der[offset++]
  const r = stripLeadingZeros(der.slice(offset, offset + rLen))
  offset += rLen
  if (der[offset++] !== 0x02) throw new Error("invalid DER signature (s)")
  const sLen = der[offset++]
  const s = stripLeadingZeros(der.slice(offset, offset + sLen))

  const out = new Uint8Array(64)
  // r、s 各自左侧补 0 到 32 字节（DER 会剥掉前导零，这里要补回来）
  out.set(r, 32 - r.length)
  out.set(s, 64 - s.length)
  return out
}

/** 去掉前导零字节，但至少保留 1 字节 */
export function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  return b.slice(i)
}

export interface DPoPTokenInput {
  /** EC P-256 私钥（CryptoKey，usage 含 sign） */
  keyPair: CryptoKey
  /** 对应公钥的 JWK 坐标（写进 JWT header，服务端用它验签） */
  publicJwk: { x: string; y: string }
  /** HTTP 方法，如 GET */
  htm?: string
  /** 目标 URL，**必须与真实请求完全一致**（含查询串），否则验签失败 */
  htu?: string
  nonce?: string
  jti?: string
  iat?: number
  now?: number
  expiresIn?: number
}

export interface DPoPTokenResult {
  dpopToken: string
  expiredTime: number
  expiresIn: number
}

/**
 * 生成 DPoP proof JWT。
 *
 * header 里嵌公钥（`jwk`），payload 声明 `htm`/`htu`/`jti`/`nonce`/`exp`，
 * 用私钥 ES256 签名。服务端会用 header 里的公钥验证「持有私钥」这件事。
 */
export async function generateDPoPToken(inp: DPoPTokenInput): Promise<DPoPTokenResult> {
  const expiresIn = inp.expiresIn && inp.expiresIn > 0 ? inp.expiresIn : defaultExpiresIn
  const now = inp.now ?? Math.floor(Date.now() / 1000)
  const iat = inp.iat && inp.iat !== 0 ? inp.iat : now

  const payload = {
    jti: inp.jti || randomUUID(),
    htm: inp.htm ?? "",
    htu: inp.htu ?? "",
    iat,
    nonce: inp.nonce || randomUUID(),
    exp: iat + expiresIn,
  }

  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: inp.publicJwk.x,
      y: inp.publicJwk.y,
    },
  }

  const hEnc = b64url(JSON.stringify(header))
  const pEnc = b64url(JSON.stringify(payload))
  const signingInput = hEnc + "." + pEnc

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    inp.keyPair,
    new TextEncoder().encode(signingInput),
  )

  const rawSig = normalizeEcdsaSignature(new Uint8Array(sig))
  const token = signingInput + "." + b64url(rawSig)

  return {
    dpopToken: token,
    expiredTime: iat + expiresIn,
    expiresIn,
  }
}

/** 生成 UUID v4（优先用运行时实现，缺失时手工构造） */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * 解析 EC P-256 私钥 JWK，导入为可用于签名的 CryptoKey。
 * 兼容两种输入：直接是 JWK，或外层套了一层 `{privateKey|keyPair|jwk}` 信封。
 */
export async function parseECPrivateKeyJWK(
  raw: string,
): Promise<{ privateKey: CryptoKey; publicJwk: { x: string; y: string } }> {
  let jwk = JSON.parse(raw)
  if (!jwk.d || !jwk.x || !jwk.y) {
    const env = jwk
    const inner = env.privateKey || env.keyPair || env.jwk
    if (!inner) throw new Error("missing private key JWK")
    jwk = inner
  }
  if (jwk.kty && jwk.kty !== "EC") throw new Error("unsupported JWK kty")
  if (jwk.crv && jwk.crv !== "P-256") throw new Error("unsupported JWK curve")
  if (!jwk.d || !jwk.x || !jwk.y) throw new Error("incomplete JWK")

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      d: jwk.d,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  )
  return { privateKey: key, publicJwk: { x: jwk.x, y: jwk.y } }
}

/**
 * 解密 Cookie 中的 `feishu_dpop_keypair`，得到私钥。
 *
 * 载荷格式：base64 → (12 字节 nonce || AES-GCM 密文)，密钥由
 * `dpop_key_secret` 经 PBKDF2-SHA256（固定盐 "fixed-salt"、10 万次迭代）
 * 派生 256 位得到。明文是私钥 JWK 的 JSON。
 *
 * 也接受 `{"data": "..."}` / `{"ciphertext": "..."}` 这类信封写法。
 */
export async function parseEncryptedDPoPKeyPair(
  raw: string,
  secret: string,
): Promise<{ privateKey: CryptoKey; publicJwk: { x: string; y: string } }> {
  const trimmed = (raw || "").trim()
  if (!trimmed) throw new Error("empty encrypted key pair")

  let ciphertext = trimmed
  if (trimmed.startsWith("{")) {
    const payload = JSON.parse(trimmed)
    const cand =
      (payload.data || "").trim() ||
      (payload.ciphertext || "").trim() ||
      (payload.encrypted || "").trim()
    if (!cand) throw new Error("missing encrypted dpop payload")
    ciphertext = cand
  }

  const decoded = decodeBase64Loose(ciphertext)
  if (decoded.length <= 12) throw new Error("encrypted dpop payload too short")

  const plain = await decryptDoubaoKeyPair(decoded, secret)
  return parseECPrivateKeyJWK(new TextDecoder().decode(plain))
}

/** PBKDF2 派生密钥 + AES-GCM 解密（格式：12 字节 IV || 密文 || 16 字节 tag） */
export async function decryptDoubaoKeyPair(
  ciphertext: Uint8Array,
  secret: string,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("fixed-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    256,
  )
  const aesKey = await crypto.subtle.importKey("raw", keyBits, "AES-GCM", false, ["decrypt"])

  const nonceSize = 12
  const nonce = ciphertext.slice(0, nonceSize)
  const enc = ciphertext.slice(nonceSize)
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, enc)
  return new Uint8Array(plain)
}

/**
 * 规范化 URL 供 DPoP 使用：去掉 fragment。
 * `htu` 必须与真实请求 URL 一致，带 `#` 会导致服务端重算不一致。
 */
export function normalizeDPoPURL(rawURL: string): string {
  try {
    const u = new URL(rawURL)
    u.hash = ""
    return u.toString()
  } catch {
    return rawURL
  }
}

/**
 * 判断 access token 是否该刷新。
 * 无 token / 解析失败 → 刷新；无 exp 声明 → 不刷新（视为长期有效）；
 * 距过期不足 `refreshAheadSeconds` → 刷新（留出网络往返余量）。
 */
export function shouldRefreshJWT(token: string, refreshAheadSeconds = 120): boolean {
  if (!token) return true
  let payload: any
  try {
    payload = parseJWTPayload(token)
  } catch {
    return true
  }
  if (!payload.exp || payload.exp <= 0) return false
  const now = Math.floor(Date.now() / 1000)
  return payload.exp <= now + refreshAheadSeconds
}
