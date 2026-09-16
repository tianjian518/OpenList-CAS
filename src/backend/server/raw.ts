import { Hono } from "hono"
import { resolvePath } from "../internal/model/db"
import { parseRangeHeader } from "../internal/stream/stream"
import { flushPendingDriverState, getDriver } from "../internal/op/storage"
import { resolveShare } from "../internal/op/share"
import { needDownloadSign, verifyDownloadSign } from "../pkg/sign"
import { safeErrorMessage } from "../pkg/errs"
import { assertSafeUrl, getTrustedHosts } from "../pkg/http"

let fsPromises: any = null
let createReadStream: any = null

async function initNodeModules() {
  if (
    typeof process !== "undefined" &&
    process.release?.name === "node" &&
    !fsPromises
  ) {
    try {
      fsPromises = await import("fs/promises")
      createReadStream = (await import("fs")).createReadStream
    } catch (e) {}
  }
}

export const rawRouter = new Hono()

/**
 * 构造 `inline` 形式的 Content-Disposition。
 *
 * 为什么必须改写：
 *   139 的 EOS 中转链固定返回
 *   `Content-Disposition: attachment; filename*=UTF-8''xxx.mp4`。
 *   播放器（实测网易爆米花）据此把响应判定为"待下载文件"而非"可播放媒体"，
 *   于是报"获取播放地址失败"。改成 inline 后浏览器/播放器按内联媒体处理。
 *
 * 文件名优先沿用上游原始 filename*，前端展示更贴近真实文件名；
 * 拿不到则用请求路径的最后一段兜底。所有取值都经过 CR/LF 清洗，
 * 避免响应头注入。
 */
function buildInlineDisposition(
  upstream: string | null,
  reqPath: string,
): string {
  const sanitize = (v: string) => v.replace(/[\r\n\u0000-\u001f]+/g, "")

  if (upstream) {
    const cleaned = sanitize(upstream)
    // `attachment; filename*=UTF-8''a.mp4` → 取分号之后的部分
    const semi = cleaned.indexOf(";")
    if (semi >= 0) {
      const params = cleaned.slice(semi + 1).trim()
      if (params) return `inline; ${params}`
    }
    // 上游只给了裸类型（无 filename），退到路径推导
  }

  const base = reqPath.split("/").filter(Boolean).pop() || "file"
  // 非 ASCII 文件名用 RFC 5987 的 filename* 编码，避免 header 出现原始中文
  const encoded = encodeURIComponent(base)
  return `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`
}

const getStorageRequestContext = (c: any) => {
  try {
    const executionCtx = c.executionCtx
    if (!executionCtx || typeof executionCtx.waitUntil !== "function") {
      return undefined
    }
    return {
      waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise),
    }
  } catch {
    return undefined
  }
}

// 安全代理下载：手动跟随重定向并逐跳做 SSRF 校验。
// 关键修复：默认 fetch 会自动跟随 3xx，导致攻击者先让 raw_url 指向一个
// 通过 isSafeUrl 校验的公网域名，再用 302 跳到内网/云元数据端点，绕过 SSRF。
// 这里禁用自动重定向，对每一跳的 Location 重新断言安全，并在跨域重定向时
// 剥离 Cookie/Authorization 等敏感头，防止认证信息泄露给第三方。
const SAFE_REDIRECT_HEADER_KEYS = new Set([
  "range",
  "user-agent",
  "accept",
  "accept-language",
  "referer",
])

async function safeProxyFetch(
  url: string,
  headers: Record<string, string>,
  allowHosts?: ReadonlySet<string> | string[],
): Promise<Response> {
  const MAX_REDIRECTS = 5
  let current = url
  let currentHeaders = headers
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    try {
      assertSafeUrl(current, "Proxy download", allowHosts)
    } catch (e: any) {
      throw new Error(e?.message || "SSRF blocked: restricted destination")
    }

    const res = await fetch(current, {
      headers: currentHeaders,
      redirect: "manual",
    })

    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString()
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(currentHeaders)) {
        if (SAFE_REDIRECT_HEADER_KEYS.has(k.toLowerCase()) && v) next[k] = v
      }
      currentHeaders = next
      continue
    }
    return res
  }
  throw new Error("Proxy download blocked: too many redirects")
}

rawRouter.get("/*", async (c) => {
  await initNodeModules()

  // 播放器/下载器请求 .cas、.strm 时优先走 302 直链，而不是服务端代理。
  //
  // 原因：
  //   1) 流量 —— .cas 背后是 GB 级真实视频，走 /p 代理会让全部字节穿过
  //      Cloudflare Worker（有每日请求/流量额度），代价极高；
  //   2) 播放体验 —— 播放器需要 302 到 CDN 直链才能做分片seek。
  //
  // 安全性由 302 分支自带的 assertSafeUrl（SSRF 校验）保障，与其它驱动一致。
  //
  // ⚠️ 例外：显式带 `?proxy=true` 时必须允许 .cas 走代理。
  //
  //   139 的 CAS 秒传恢复出的临时文件只能拿到 EOS 中转链，该链的
  //   `Content-Disposition` 是 **attachment**（强制下载）。网易爆米花这类
  //   播放器据此判定"这是要下载的文件而非可播放媒体"，直接报"获取播放
  //   地址失败"。
  //   同时 EOS 对 HEAD 请求返回 403（仅 GET/GET+Range 正常），而播放器探测
  //   可用性普遍先发 HEAD —— 双重障碍。
  //   代理分支能改写 Content-Disposition 为 inline 并把 HEAD 降级为 GET，
  //   从而绕开这两个问题。用户可在存储上开 web_proxy 走这条路。
  const isCasOrStrmFile = /\.(cas|strm)$/i.test(
    decodeURIComponent(c.req.path).split("?")[0],
  )
  const explicitProxy = c.req.query("proxy") === "true"

  const isProxy =
    (!isCasOrStrmFile || explicitProxy) &&
    (explicitProxy ||
      c.req.path.startsWith("/p") ||
      c.req.path.startsWith("/api/p") ||
      c.req.path.startsWith("/sd") ||
      c.req.path.startsWith("/api/sd"))

  // 媒体文件判定（供 Content-Disposition 改写使用）。
  // 与驱动侧的扩展名习惯保持一致：常见视频/音频/字幕。
  const MEDIA_EXT_RE =
    /\.(mp4|mkv|webm|avi|mov|flv|wmv|ts|m2ts|m4v|mpg|mpeg|rmvb|3gp|mp3|flac|aac|wav|ogg|m4a|wma|alac|ape|srt|ass|vtt|sub)$/i
  const isMediaPath = MEDIA_EXT_RE.test(
    decodeURIComponent(c.req.path).split("?")[0],
  )

  const rawPath = c.req.path
    .replace(/^\/api\/raw/, "")
    .replace(/^\/api\/d/, "")
    .replace(/^\/api\/sd/, "")
    .replace(/^\/api\/p/, "")
    .replace(/^\/raw/, "")
    .replace(/^\/d/, "")
    .replace(/^\/sd/, "")
    .replace(/^\/p/, "")

  const reqPath0 = decodeURIComponent(rawPath)

  try {
    let reqPath = reqPath0
    // Share download: /sd/{shareId}/... — map to the real storage path
    const isSharePath =
      c.req.path.startsWith("/api/sd") || c.req.path.startsWith("/sd")
    if (isSharePath) {
      // 分享密码优先从 cookie（browser-password）读取，避免密码出现在 URL 中；
      // 兼容旧版 ?pwd= 参数（已有分享链接/收藏夹里的旧链接仍可用）。
      const cookieHeader = c.req.header("Cookie") || ""
      const cookiePwdRaw =
        cookieHeader
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("browser-password="))
          ?.split("=")
          .slice(1)
          .join("=") || ""
      let cookiePwd: string
      try {
        cookiePwd = cookiePwdRaw ? decodeURIComponent(cookiePwdRaw) : ""
      } catch {
        cookiePwd = cookiePwdRaw
      }
      const sharePwd = c.req.query("pwd") || cookiePwd
      const shareRes = await resolveShare(reqPath, sharePwd, c.env)
      if (!shareRes.ok) {
        return c.text(shareRes.error || "Share not found", 404)
      }
      if (shareRes.virtualList || !shareRes.realPath) {
        return c.text("Cannot download share root", 400)
      }
      reqPath = shareRes.realPath
    } else {
      // 对齐 Go server/router.go：
      //   r.GET("/d/*path", middlewares.PathParse, middlewares.Down(sign.Verify), ...)
      //   r.GET("/p/*path", middlewares.PathParse, middlewares.Down(sign.Verify), ...)
      //
      // 这两个端点**没有 Auth 中间件**，是设计上的「公开下载端点」——
      // 直链要能被 <video src>、<img src>、播放器、下载器直接消费，而这些
      // 客户端无法携带 Authorization 头。访问控制完全由 needSign 决定：
      // 需要签名时校验签名，不需要时公开放行。
      //
      // 此前 TS 版在此处强制要求登录用户，与 Go 不符：guest 存在时靠 guest
      // 兜底看不出问题，guest 一被禁用，列目录/播放视频就全部 401。
      if (await needDownloadSign(c, reqPath)) {
        const sign = c.req.query("sign") || ""
        const ok = await verifyDownloadSign(c, reqPath, sign)
        if (!ok) {
          return c.text("sign verify failed", 401)
        }
      }
    }

    const resolved = await resolvePath(reqPath)

    if (resolved.isVirtual || !resolved.physical) {
      return c.text("Cannot download virtual directory path", 400)
    }

    if (resolved.storage) {
      const normDriver = (resolved.storage.driver || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")

      // Remote cloud drivers: fetch download link via driver.get()
      if (normDriver !== "local") {
        try {
          // 管理员配置的受信存储 endpoint host（可能是内网自建 S3/WebDAV/MinIO），
          // 加上全局环境变量 SSRF_ALLOWED_HOSTS，合并为 SSRF 白名单，避免被误拦截。
          const trustedHosts = getTrustedHosts(resolved.storage.addition, c.env)
          const driver = await getDriver(
            resolved.storage.driver,
            resolved.storage,
            // 注入当次请求 origin：strm 驱动据此把 .strm 内容写成绝对 URL
            (() => {
              try {
                return new URL(c.req.url).origin
              } catch {
                return undefined
              }
            })(),
          )
          let fileItem
          try {
            fileItem = await driver.get(reqPath, resolved.physical)
          } finally {
            await flushPendingDriverState(
              resolved.storage.driver,
              resolved.storage,
              driver,
              getStorageRequestContext(c),
            )
          }

          if (fileItem && fileItem.raw_url) {
            // WebDAV 等需要认证的驱动：强制使用代理模式，避免重定向导致认证丢失
            const needsProxy =
              isProxy ||
              normDriver === "webdav" ||
              normDriver === "sharepoint" ||
              normDriver === "onedrive" ||
              normDriver === "onedriveapp" ||
              normDriver === "weiyun" ||
              normDriver === "tencentweiyun"
            if (needsProxy) {
              console.log(
                `[rawRouter] Proxying download for '${reqPath}' via ${resolved.storage.driver}`,
              )
              // Start with driver-provided headers (Cookie, Referer, etc.)
              const headers: Record<string, string> = {
                ...(fileItem.raw_url_headers || {}),
              }
              // Ensure a User-Agent is set (don't override if driver already set one)
              if (!headers["User-Agent"]) {
                headers["User-Agent"] =
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
              }
              // Forward Range header for video/audio/PDF seeking
              const rangeReq = c.req.header("Range")
              if (rangeReq) headers["Range"] = rangeReq

              // HEAD 降级为 GET。
              //
              // 背景：139 的 EOS 中转链对 HEAD 一律返回 403（GET / GET+Range
              // 正常返回 200 / 206）。播放器在正式播放前普遍会先发 HEAD 探测
              // 文件是否可访问、大小多少，拿到 403 就直接判定"不可播放"。
              // 这里对上游始终用 GET，若客户端本意是 HEAD 则丢弃响应体、
              // 只回响应头，语义上等价于 HEAD，但对上游友好。
              const clientWantsHead = c.req.method === "HEAD"

              let upstreamRes: Response
              try {
                upstreamRes = await safeProxyFetch(
                  fileItem.raw_url,
                  headers,
                  trustedHosts,
                )
              } catch (ssrfErr: any) {
                return c.text(ssrfErr.message || "SSRF blocked", 403)
              }

              // If upstream returns 412 Precondition Failed (e.g. strict OSS check), retry with plain GET without Range
              if (upstreamRes.status === 412) {
                console.warn(
                  `[rawRouter] Upstream returned 412 for '${reqPath}', retrying without Range header...`,
                )
                delete headers["Range"]
                upstreamRes = await safeProxyFetch(
                  fileItem.raw_url,
                  headers,
                  trustedHosts,
                )
              }

              // CORS headers
              c.header("Access-Control-Allow-Origin", "*")
              c.header("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD")
              c.header(
                "Access-Control-Expose-Headers",
                "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
              )

              // Content-Type: prefer upstream, fallback by extension
              const extMap: Record<string, string> = {
                pdf: "application/pdf",
                mp4: "video/mp4",
                webm: "video/webm",
                mkv: "video/x-matroska",
                mp3: "audio/mpeg",
                flac: "audio/flac",
                m3u8: "application/vnd.apple.mpegurl",
                ts: "video/mp2t",
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
                svg: "image/svg+xml",
              }
              const fileExt = reqPath.split(".").pop()?.toLowerCase() || ""
              const defaultContentType =
                extMap[fileExt] || "application/octet-stream"
              c.header(
                "Content-Type",
                upstreamRes.headers.get("content-type") || defaultContentType,
              )

              // Forward range/length headers
              const contentLength = upstreamRes.headers.get("content-length")
              if (contentLength) c.header("Content-Length", contentLength)
              const contentRange = upstreamRes.headers.get("content-range")
              if (contentRange) c.header("Content-Range", contentRange)
              // Always advertise range support so video/audio players can seek
              c.header(
                "Accept-Ranges",
                upstreamRes.headers.get("accept-ranges") || "bytes",
              )

              // Forward caching headers
              const etag = upstreamRes.headers.get("etag")
              if (etag) c.header("ETag", etag)
              const lastModified = upstreamRes.headers.get("last-modified")
              if (lastModified) c.header("Last-Modified", lastModified)
              const cacheControl = upstreamRes.headers.get("cache-control")
              if (cacheControl) c.header("Cache-Control", cacheControl)
              // FIX(H-3): 上游响应头已按白名单回显，但对 Content-Disposition 额外
              // 清洗 CR/LF 与控制字符，防止恶意上游注入额外响应头（Set-Cookie/Location）。
              //
              // 播放场景特例：媒体文件（.cas/.strm 及其它音视频扩展名）必须
              // 以 inline 回给播放器。
              // 上游 139 EOS 中转链固定带 `attachment`，播放器会把它当成
              // "待下载文件"而非"可播放媒体"，表现为"获取播放地址失败"。
              // 这里对媒体文件强制改写为 inline，仅保留文件名。
              const contentDisposition = upstreamRes.headers.get(
                "content-disposition",
              )
              if (isCasOrStrmFile || isMediaPath) {
                c.header(
                  "Content-Disposition",
                  buildInlineDisposition(contentDisposition, reqPath),
                )
              } else if (contentDisposition) {
                const safeDisposition = contentDisposition.replace(
                  /[\r\n\u0000-\u001f]+/g,
                  "",
                )
                c.header("Content-Disposition", safeDisposition)
              }

              // 客户端本意是 HEAD：只回响应头，丢弃上游响应体。
              // 上游已用 GET 取得（EOS 对 HEAD 返回 403），这里主动 cancel
              // 以免无谓地拉取整个文件。
              if (clientWantsHead) {
                try {
                  await upstreamRes.body?.cancel()
                } catch {
                  // 忽略：部分运行时 body 不可 cancel
                }
                return c.body(null, upstreamRes.status as any)
              }

              return c.body(upstreamRes.body as any, upstreamRes.status as any)
            } else {
              try {
                assertSafeUrl(fileItem.raw_url, "Redirect download", trustedHosts)
              } catch (ssrfErr: any) {
                return c.text(ssrfErr.message || "SSRF blocked", 403)
              }
              console.log(
                `[rawRouter] Redirecting download for '${reqPath}' via ${resolved.storage.driver}`,
              )
              return c.redirect(fileItem.raw_url, 302)
            }
          } else if (
            typeof (driver as any).createReadStream === "function" &&
            fileItem &&
            !fileItem.is_dir
          ) {
            c.header("Access-Control-Allow-Origin", "*")
            const size = fileItem.size || 0
            const rangeHeader = c.req.header("Range")
            if (rangeHeader && size > 0) {
              const { start, end, chunksize } = parseRangeHeader(
                rangeHeader,
                size,
              )
              const stream = await (driver as any).createReadStream(
                resolved.physical,
                { start, end },
              )
              c.header("Content-Range", `bytes ${start}-${end}/${size}`)
              c.header("Accept-Ranges", "bytes")
              c.header("Content-Length", chunksize.toString())
              c.header("Content-Type", "application/octet-stream")
              return c.body(stream as any, 206)
            } else {
              if (size > 0) c.header("Content-Length", size.toString())
              c.header("Accept-Ranges", "bytes")
              c.header("Content-Type", "application/octet-stream")
              const stream = await (driver as any).createReadStream(
                resolved.physical,
              )
              return c.body(stream as any)
            }
          } else {
            const detail =
              fileItem?.raw_url_error ||
              (fileItem?.is_dir
                ? "该条目是文件夹，不可作为文件下载。"
                : "该存储驱动未返回下载链接（raw_url 为空）。")
            return c.text(
              `File not found or no download link available: ${reqPath}\n${detail}`,
              404,
            )
          }
        } catch (e: any) {
          console.error(
            `[rawRouter] Driver get failed for '${reqPath}':`,
            e.message,
          )
          return c.text(`Download failed: ${safeErrorMessage(e)}`, 500)
        }
      }
    }

    // Fallback: Local file system streaming
    if (!fsPromises || !createReadStream) {
      return c.text("Local file streaming not supported in Edge Runtime", 500)
    }

    const stat = await fsPromises.stat(resolved.physical)
    if (stat.isDirectory()) {
      return c.text("Cannot download directory", 400)
    }

    c.header("Access-Control-Allow-Origin", "*")
    const rangeHeader = c.req.header("Range")
    if (rangeHeader) {
      const { start, end, chunksize } = parseRangeHeader(rangeHeader, stat.size)
      const stream = createReadStream(resolved.physical, { start, end })

      c.header("Content-Range", `bytes ${start}-${end}/${stat.size}`)
      c.header("Accept-Ranges", "bytes")
      c.header("Content-Length", chunksize.toString())
      c.header("Content-Type", "application/octet-stream")
      return c.body(stream as any, 206)
    } else {
      c.header("Content-Length", stat.size.toString())
      c.header("Accept-Ranges", "bytes")
      const stream = createReadStream(resolved.physical)
      return c.body(stream as any)
    }
  } catch (err: any) {
    console.error(`[rawRouter] Download 404 for '${reqPath0}':`, err.message)
    return c.text(`Not found: ${safeErrorMessage(err, "file not found")}`, 404)
  }
})
