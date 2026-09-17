import { getDb } from "../internal/model/db"
import { getJwtSecret } from "../server/middlewares"
import { hmacSha256Base64Url } from "./crypto"

/**
 * 下载链接签名（防盗链 / 链接过期）。
 *
 * 对齐 Go 版（139cas / OpenList）的 `internal/sign` + `server/common/sign.go`：
 *
 *   签名格式：`<base64url(HMAC-SHA256(path + ":" + expire))>:<expire>`
 *   - 待签名数据 = `path + ":" + expire`
 *   - expire 为 0 表示**永不过期**（Go `NotExpired`）
 *   - secret 来源 = `setting.GetStr(conf.Token)`，TS 侧复用 getJwtSecret
 *
 * 启用条件（任一成立即需签名，对齐 Go `server/middlewares/down.go needSign`）：
 *   1. 站点设置 `sign_all === "true"`；
 *   2. 命中存储的 `enable_sign === true`（Go `IsStorageSignEnabled`）；
 *   3. 路径命中带密码的 meta，且该 meta 覆盖此路径。
 *
 * 三者全关时本模块静默（enabled=false），行为与未启用完全一致。
 */

const DEFAULT_SIGN_EXPIRES_SECONDS = 24 * 3600 // sign_all 开启但未配过期时默认 24h

/** 恒定时间比较（十六进制字符串），避免 HMAC 验签被时序侧信道攻击（M-1） */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** 恒定时间比较（任意字符串），用于 Go 格式签名的整体比对 */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export interface SignPolicy {
  enabled: boolean
  expiresIn: number
}

export async function getSignPolicy(c: any): Promise<SignPolicy> {
  try {
    const db = await getDb(c?.env)
    const settings: Record<string, string> = {}
    for (const s of db.settings || []) settings[s.key] = s.value
    const signAll = settings.sign_all === "true"
    // link_expiration 单位为【小时】（对齐 Go time.Hour）
    const linkExpHours = parseInt(settings.link_expiration, 10) || 0
    if (!signAll && linkExpHours <= 0) {
      return { enabled: false, expiresIn: 0 }
    }
    return {
      enabled: true,
      // 0 = 永不过期（对齐 Go NotExpired）。此前用 DEFAULT_SIGN_EXPIRES_SECONDS
      // 兜底成 24h，与 Go 行为不符，且会让 strm 里持久化的签名次日失效。
      expiresIn: linkExpHours > 0 ? linkExpHours * 3600 : 0,
    }
  } catch {
    return { enabled: false, expiresIn: 0 }
  }
}

/** 规范化路径（对齐 Go utils.FixAndCleanPath） */
function fixAndCleanPath(p: string): string {
  return "/" + String(p || "").split("/").filter(Boolean).join("/")
}

/**
 * meta 是否覆盖该路径（对齐 Go server/common.MetaCoversPath）。
 * applyToSubFolder 为 false 时只匹配自身，为 true 时向上匹配所有祖先。
 */
export function metaCoversPath(
  metaPath: string,
  reqPath: string,
  applyToSubFolder: boolean,
): boolean {
  const mp = fixAndCleanPath(metaPath).toLowerCase()
  let rp = fixAndCleanPath(reqPath).toLowerCase()
  if (mp === rp) return true
  if (!applyToSubFolder) return false
  while (rp !== "/") {
    rp = fixAndCleanPath(rp.split("/").slice(0, -1).join("/"))
    if (mp === rp) return true
  }
  return false
}

/**
 * 取距离该路径最近的 meta（对齐 Go op.GetNearestMeta）：
 * 从自身逐级向上查找，返回首个存在的 meta。
 */
export async function getNearestMeta(
  c: any,
  reqPath: string,
): Promise<any | null> {
  try {
    const db = await getDb(c?.env)
    const metas = db.metas || []
    if (!metas.length) return null
    let p = fixAndCleanPath(reqPath)
    for (;;) {
      const hit = metas.find(
        (m: any) => fixAndCleanPath(m.path).toLowerCase() === p.toLowerCase(),
      )
      if (hit) return hit
      if (p === "/") return null
      p = fixAndCleanPath(p.split("/").slice(0, -1).join("/"))
    }
  } catch {
    return null
  }
}

/**
 * 该路径是否处于「密码保护」状态（对齐 Go server/handles.isEncrypt）。
 *
 * Go 版还包含 IsStorageSignEnabled（存储级 EnableSign），TS 侧尚无该字段，
 * 故此处仅实现 meta 密码分支。
 */
export async function isEncryptPath(
  c: any,
  reqPath: string,
): Promise<boolean> {
  const meta = await getNearestMeta(c, reqPath)
  if (!meta || !meta.password) return false
  return metaCoversPath(meta.path, reqPath, !!meta.p_sub)
}

/**
 * 该路径所属存储是否开启了「强制签名」。
 * 对齐 Go `server/common/check.go`：
 *   func IsStorageSignEnabled(rawPath string) bool {
 *     storage := op.GetBalancedStorage(rawPath)
 *     return storage != nil && storage.GetStorage().EnableSign
 *   }
 *
 * 注意：storages 是【按最长 mount_path 前缀匹配】（Go GetBalancedStorage 语义）。
 */
export async function isStorageSignEnabled(
  c: any,
  reqPath: string,
): Promise<boolean> {
  try {
    const db = await getDb(c?.env)
    const storages = db.storages || []
    if (!storages.length) return false
    const rp = fixAndCleanPath(reqPath)
    let best: any = null
    let bestLen = -1
    for (const st of storages) {
      if (!st || st.disabled) continue
      const mp = fixAndCleanPath(st.mount_path || "/")
      const hit = mp === "/" ? true : rp === mp || rp.startsWith(mp + "/")
      if (hit && mp.length > bestLen) {
        best = st
        bestLen = mp.length
      }
    }
    if (!best) return false
    // ① 存储顶层 enable_sign（Go 版 model.Storage.EnableSign 的等价字段）
    if (best.enable_sign) return true
    // ② 兼容旧配置：驱动 addition 里的 enableSign
    //    用户历史配置把它写在了 addition 里（如 strm 存储），需一并识别，
    //    否则「明明开了签名却不验签」。
    try {
      const add =
        typeof best.addition === "string"
          ? JSON.parse(best.addition || "{}")
          : best.addition || {}
      if (add && (add.enableSign === true || add.enable_sign === true)) {
        return true
      }
    } catch {}
    return false
  } catch {
    return false
  }
}

/**
 * 下载是否必须携带签名（对齐 Go server/middlewares.needSign）。
 *
 * Go 的 /d、/p 是「公开下载端点」，链路为
 *   PathParse → Down(sign.Verify) → downloadLimiter → handles.Down/Proxy
 * 全程没有 Auth 中间件。是否放行只取决于本函数：
 *   - sign_all 开启              → 需要签名
 *   - （TS 扩展）link_expiration → 需要签名
 *   - 命中存储 enable_sign       → 需要签名（Go IsStorageSignEnabled）
 *   - meta 设了密码且覆盖该路径  → 需要签名
 *   - 否则                       → 无需签名，直接公开访问
 */
export async function needDownloadSign(
  c: any,
  reqPath: string,
): Promise<boolean> {
  const policy = await getSignPolicy(c)
  if (policy.enabled) return true
  if (await isStorageSignEnabled(c, reqPath)) return true
  return await isEncryptPath(c, reqPath)
}

/**
 * 签名有效期（秒）。**严格对齐 Go `internal/sign.Sign`：**
 *
 *   expire := setting.GetInt(conf.LinkExpiration, 0)
 *   if expire == 0 { return NotExpired(data) }   // ← 0 = 永不过期
 *   else { return WithDuration(data, expire * time.Hour) }
 *
 * 即：站点设置 link_expiration=0（默认）时，签名永不过期（expire 字段写 0）。
 * 这对 strm 场景是**必须**的 —— strm 文件一经生成就长期保存，
 * 若签名 24h 过期，播放器次日再播就会 401。
 *
 * 返回值 0 表示永不过期（调用方据此向 signDownloadPath 传 0）。
 */
export async function getSignExpiresIn(c: any): Promise<number> {
  try {
    const db = await getDb(c?.env)
    // link_expiration 单位是【小时】（对齐 Go time.Hour）
    const hours = getLinkExpirationHours(db)
    // 0 才是「未配置 / 永不过期」；负数照样透传，让签名立即失效
    if (hours !== 0) return hours * 3600
  } catch {}
  // 未配置 → 永不过期（Go NotExpired 语义），而不是默认 24h
  return 0
}

/**
 * 读取站点 link_expiration（小时）。返回 0 表示未配置（= 永不过期）。
 * 同时导出给 strm 驱动注入签名上下文时复用。
 *
 * 注意保留负数的**原值**而不是归一成 0：
 * 负数在 Go 里代表「已过期」（时间戳落在过去），若在这里当 0 处理，
 * 管理员误填 `link_expiration = -1` 会让链接变成**永不过期**——
 * 与配置意图（限制有效期）完全相反，属于安全隐患。
 */
export function getLinkExpirationHours(db: any): number {
  try {
    for (const s of db?.settings || []) {
      if (s.key === "link_expiration") {
        const n = parseInt(s.value, 10)
        return Number.isFinite(n) ? n : 0
      }
    }
  } catch {}
  return 0
}

/**
 * 生成签名，**完全对齐 Go `pkg/sign/hmac.go`**：
 *
 *   func (s HMACSign) Sign(data string, expire int64) string {
 *     h := hmac.New(sha256.New, s.SecretKey)
 *     expireTimeStamp := strconv.FormatInt(expire, 10)
 *     io.WriteString(h, data+":"+expireTimeStamp)
 *     return base64.URLEncoding.EncodeToString(h.Sum(nil)) + ":" + expireTimeStamp
 *   }
 *
 * 输出形如 `Xy3..._a=:1712345678`。
 * expire === 0 表示永不过期（Go `NotExpired`）。
 *
 * @param expiresIn 有效期（秒）。传 0 表示永不过期；**负数表示已过期**
 *                  （对齐 Go：负数时间戳落在过去，NotExpired 判定为已失效）。
 */
export async function signDownloadPathRaw(
  c: any,
  virtualPath: string,
  expiresIn: number,
): Promise<string> {
  const secret = await getJwtSecret(c)
  const expire =
    expiresIn === 0
      ? 0 // 0 = 永不过期（Go NotExpired 语义）
      : Math.floor(Date.now() / 1000) + expiresIn
  return signWithSecret(secret, virtualPath, expire)
}

/** 纯函数：用指定 secret 生成 Go 格式签名（expire=0 → 永不过期） */
export async function signWithSecret(
  secret: string,
  data: string,
  expire: number,
): Promise<string> {
  const mac = await hmacSha256Base64Url(`${data}:${expire}`, secret)
  return `${mac}:${expire}`
}

/**
 * 保持旧签名兼容：signDownloadPath(c, path, expiresIn) 语义不变，
 * 但输出格式已切换为 Go 版 `base64url(hmac):expires`。
 */
export async function signDownloadPath(
  c: any,
  virtualPath: string,
  expiresIn: number,
): Promise<string> {
  return signDownloadPathRaw(c, virtualPath, expiresIn)
}

/**
 * 校验签名，**对齐 Go `pkg/sign/hmac.go Verify`** + `internal/sign.Verify`：
 *   - 取最后一个 ':' 之后的段作为 expire；
 *   - expire 为空 → 无效；
 *   - expire 非法数字 → 无效；
 *   - expire !== 0 且已过期 → 无效；
 *   - 重新签名后整体比对（恒定时间）。
 *
 * 同时**向后兼容** TS 旧格式 `${expires}.${hmacHex}`，避免老链接立刻失效。
 */
export async function verifyDownloadSign(
  c: any,
  virtualPath: string,
  sign: string,
): Promise<boolean> {
  if (!sign) return false
  const secret = await getJwtSecret(c)

  // ── 1) Go 格式：<base64url(hmac)>:<expire> ──────────────────────────────
  const colon = sign.lastIndexOf(":")
  if (colon > 0) {
    const expStr = sign.slice(colon + 1)
    if (expStr === "") return false
    const expires = parseInt(expStr, 10)
    if (!Number.isFinite(expires)) return false
    if (expires !== 0 && expires < Math.floor(Date.now() / 1000)) return false
    const expect = await signWithSecret(secret, virtualPath, expires)
    if (constantTimeEqual(expect, sign)) return true
    // 继续尝试旧格式（某些 key 里可能含 ':'，不提前 return false）
  }

  // ── 2) 旧 TS 格式：<expires>.<hmacHex>（向后兼容）──────────────────────
  const dot = sign.lastIndexOf(".")
  if (dot > 0) {
    const expires = parseInt(sign.slice(0, dot), 10)
    const hmac = sign.slice(dot + 1)
    if (
      Number.isFinite(expires) &&
      expires > Math.floor(Date.now() / 1000) &&
      hmac
    ) {
      const { hmacSha256 } = await import("./crypto")
      const expect = await hmacSha256(`${virtualPath}:${expires}`, secret)
      if (constantTimeEqualHex(expect, hmac)) return true
    }
  }

  return false
}
