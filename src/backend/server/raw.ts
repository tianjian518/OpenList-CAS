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

// Content-Type 兜底映射：上游未给 content-type 时按扩展名推导
const EXT_MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  rmvb: "application/vnd.rn-realmedia-vbr",
  "3gp": "video/3gpp",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  wma: "audio/x-ms-wma",
  alac: "audio/mp4",
  ape: "audio/x-ape",
  m3u8: "application/vnd.apple.mpegurl",
  srt: "application/x-subrip",
  ass: "text/x-ssa",
  vtt: "text/vtt",
  sub: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

export const rawRouter = new Hono()

const getStorageRequestContext = (c: any) => {
  try {
    const executionCtx = c.executionCtx
    if (!executionCtx || typeof executionCtx.waitUntil !== "function") {
      return undefined
    }
    return {
      waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise),
      // 请求级站点 origin：op 层透传给 getDriver，strm 据此生成绝对 URL
      requestOrigin: (() => {
        try {
          return new URL(c.req.url).origin
        } catch {
          return undefined
        }
      })(),
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
  // ⚠️ 例外：**strm 驱动**。其 Config 里 `OnlyProxy: true`，Go 侧
  // `ShouldProxy()` 恒为 true，真实文件恒走 `/p` 代理。所以对 strm 不做
  // 302 到 CDN 的短路，而是交给下面的 strm 专用分支生成 `/p` 代理地址。
  const isPlaylistFile = /\.(cas|strm)$/i.test(
    decodeURIComponent(c.req.path).split("?")[0],
  )

  // 本次请求是否**已经**是从 `/p` / `/d` 进来的（服务端代理端点）。
  // 由 strm 的 `linkUrl()` 生成的 `/p...` 地址再次回到本路由时就命中这里。
  const isProxyEndpoint = /^\/(api\/)?(p|d|sd)(\/|$)/.test(c.req.path)

  const isProxy =
    !isPlaylistFile &&
    (c.req.query("proxy") === "true" ||
      c.req.path.startsWith("/p") ||
      c.req.path.startsWith("/api/p") ||
      c.req.path.startsWith("/sd") ||
      c.req.path.startsWith("/api/sd"))


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

          // ── 139 CAS 播放：还原真实文件后 302 到直链 ─────────────────────
          //
          // 对齐 Go `server/handles/down.go` 的 Down()：
          //
          //   if shouldPreviewCASOnDown(c) || shouldRestoreCASOnDownload(storage, filename) {
          //     link, file, ok, _ := linkCASPreview(c, rawPath, storage, ...)
          //     if ok {
          //       if common.ShouldProxy(storage, file.GetName()) { proxy(...) }
          //       else { redirect(c, link) }     // ← 302 到真实文件直链
          //       return
          //     }
          //   }
          //
          // `shouldPreviewCASOnDown` 在 **播放器请求时必然为真**：
          //   有 Range 头 / Accept 含 video|audio / Sec-Fetch-Dest ∈ {video,audio}
          //
          // 链路：`.cas` 占位文件 → 秒传还原出真实视频（TEMP_139CAS_..._第10集.mkv）
          //      → 取该文件的 CDN 直链 → 302 过去。
          //
          // 为什么必须 302 而不能由 Worker 代理：
          //   还原后的真实文件动辄 1.5~3 GB，Worker 代理意味着**全部字节穿过
          //   Cloudflare**，会在播放中途触发平台的流量/CPU 限制而断流，播放器
          //   表现为「无法播放」。Go 版正是靠 302 把流量交给 CDN 才能顺畅播放。
          //   实测：代理模式 200 + 1.57GB 由 Worker 回传；302 模式与 139cas 完全一致。
          //
          // 判定与还原细节在 139 驱动的 `get()`/`link()` 里实现（resolveCasPlayLink），
          // 这里只负责在「播放器请求」这一时机把直链交给播放器。
          {
            const nd = normDriver
            const is139 =
              nd === "139" || nd === "yun139" || nd === "139yun"
            const playerLike =
              !!c.req.header("Range") ||
              /video\/|audio\//i.test(c.req.header("Accept") || "") ||
              ["video", "audio"].includes(
                (c.req.header("Sec-Fetch-Dest") || "").toLowerCase(),
              )
            if (is139 && playerLike && /\.cas$/i.test(reqPath)) {
              // 优先复用 `driver.get()` 已经还原好的直链。
              //
              // 139 驱动的 `get()` 内部就会对 `.cas` 调用 resolveCasPlayLink
              // 做秒传还原，并把真实文件直链放进 `raw_url`。若这里再调一次
              // `driver.link()`，等于**同一请求内做两遍秒传恢复** —— 第二遍
              // 会因为临时文件已存在 / 子请求超限而失败，被 catch 吞掉后
              // 回退成「代理那个 540 字节的占位文件」，播放器拿到垃圾数据。
              //
              // `.cas` 底层直链的特征：指向移动云 CDN（含 eos / mcloud 域名），
              // 而不是本站的 `/api/p/...` 代理地址。以 540 字节占位文件大小为
              // 辅证，避免把「还原失败后的占位直链」误判为已还原。
              const raw = String(fileItem?.raw_url || "")
              const restored =
                !!raw &&
                !raw.startsWith("/api/p/") &&
                !raw.startsWith("/p/") &&
                !raw.startsWith("/api/d/") &&
                !raw.startsWith("/d/")
              let casUrl = restored ? raw : ""
              if (!casUrl && typeof (driver as any).link === "function") {
                try {
                  const casLink = await (driver as any).link(
                    reqPath,
                    resolved.physical,
                  )
                  casUrl = casLink?.url || ""
                } catch (casErr: any) {
                  console.warn(
                    `[rawRouter] CAS link failed for '${reqPath}':`,
                    casErr?.message,
                  )
                }
              }
              if (casUrl && !casUrl.startsWith("/")) {
                console.log(
                  `[rawRouter] CAS 302 for '${reqPath}' (${normDriver}, reused=${restored})`,
                )
                // 对齐 Go：Gin 的 `c.Redirect(302, url)` 会自动补上
                // `Content-Type: text/html; charset=utf-8`，此处显式补齐，
                // 保证与 139cas 的响应头逐项一致。
                c.header("Content-Type", "text/html; charset=utf-8")
                c.header(
                  "Cache-Control",
                  "max-age=0, no-cache, no-store, must-revalidate",
                )
                c.header("Referrer-Policy", "no-referrer")
                return c.body(null, 302, { Location: casUrl })
              }
            }
          }

          // ── strm 驱动的 /p 代理分支（对齐 Go `(d *Strm) Link` 的分支 ③）────
          //
          // Go 版 strm 驱动 `Config.OnlyProxy = true`，于是
          // `common.ShouldProxy()` 恒为 true，`d.link()` 永远返回 `(nil, obj, nil)`，
          // 使 `Link` 走分支 ③：
          //
          //   return &model.Link{URL: fmt.Sprintf("%s/p%s?sign=%s",
          //     common.GetApiUrl(ctx), utils.EncodePath(reqPath, true),
          //     sign.Sign(reqPath))}, nil
          //
          // 即：**strm 下的真实文件（.cas 等）拿到的下载地址恒为
          // `{apiUrl}/p{EncodePath(virtualPath,true)}?sign={sign(virtualPath)}`**，
          // 而不是底层驱动给出的 CDN 直链。`.strm` 里写的 `/d/...` 也一样，
          // 服务端再改写成 `/p` 代理 —— 这是驱动与前端的契约。
          //
          // 139cas 正是靠这条链路才能被网易爆米花播放。CF 版此前对 strm
          // 直接 302 到 CDN 直链，与 Go 行为不一致。
          if (fileItem && fileItem.raw_url && normDriver === "strm") {
            const virtualPath = fileItem.path || reqPath
            try {
              const proxied = await (driver as any).linkUrl(virtualPath)
              if (proxied) {
                // 防止自指死循环：若生成的代理地址指向的就是本次请求，
                // 说明底层 get 没能解析出真实条目，直接放弃代理分支。
                const selfUrl = (() => {
                  try {
                    return new URL(c.req.url).toString()
                  } catch {
                    return ""
                  }
                })()
                if (proxied === selfUrl) {
                  console.warn(
                    `[rawRouter] strm linkUrl self-reference for '${virtualPath}', skip proxy`,
                  )
                } else {
                  console.log(
                    `[rawRouter] strm /p proxy for '${virtualPath}' -> ${proxied}`,
                  )
                  c.header(
                    "Cache-Control",
                    "max-age=0, no-cache, no-store, must-revalidate",
                  )
                  c.header("Referrer-Policy", "no-referrer")
                  return c.body(null, 302, { Location: proxied })
                }
              }
            } catch (e: any) {
              console.warn(
                `[rawRouter] strm linkUrl failed for '${virtualPath}':`,
                e?.message,
              )
            }
          }

          if (fileItem && fileItem.raw_url) {
            // 对齐 Go `common.ShouldProxy(storage, filename)`：
            //   if storage.Config().MustProxy() || storage.GetStorage().WebProxy { return true }
            //   if utils.SliceContains(conf.ProxyTypes, ext) { return true }
            //   return false
            //
            // 其中 `MustProxy() = OnlyProxy || NoLinkURL`。**Strm 驱动的
            // Config 同时开了 `OnlyProxy: true` 和 `NoLinkURL: true`**，
            // 于是 ShouldProxy 恒为 true —— Go 侧 strm 下的真实文件
            // （.cas 等）永远走 `/p` 服务端代理，**绝不会 302 到 CDN 直链**。
            //
            // 这是本驱动与前端的契约：`.strm` 里写的是 `/d/...`，
            // 播放器拿到后请求 `/d`，服务端再改写成 `/p` 代理。
            // 此前 CF 版没有 MustProxy 概念，对 strm 直接 302 到 CDN，
            // 与 Go 行为不一致。
            const mustProxyDrivers = new Set([
              "virtual",
              "crypt",
              "chunk",
              "smb",
              "ftp",
              "sftp",
              "protondrive",
              "halalcloud",
              "mega",
            ])
            // 来自 `/p` / `/d` 端点的请求，本身就是「要求代理」的语义
            // （Go：`/p` 走 `ProxyHandler`，`/d` 在 ShouldProxy 为真时也转代理）。
            // 典型场景：strm 的 `linkUrl()` 生成 `/p...`，请求回到本路由时
            // 底层已是 139Yun 这类普通驱动，必须继续代理而不能 302 回 CDN。
            const driverNeedsProxy =
              isProxyEndpoint ||
              mustProxyDrivers.has(normDriver) ||
              (() => {
                try {
                  const ad =
                    typeof resolved.storage.addition === "string"
                      ? JSON.parse(resolved.storage.addition)
                      : resolved.storage.addition
                  return !!ad?.web_proxy
                } catch {
                  return false
                }
              })()
            const needsProxy =
              isProxy ||
              driverNeedsProxy ||
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
              const fileExt = reqPath.split(".").pop()?.toLowerCase() || ""
              const defaultContentType =
                EXT_MIME_MAP[fileExt] || "application/octet-stream"
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
              const contentDisposition = upstreamRes.headers.get(
                "content-disposition",
              )
              if (contentDisposition) {
                const safeDisposition = contentDisposition.replace(
                  /[\r\n\u0000-\u001f]+/g,
                  "",
                )
                c.header("Content-Disposition", safeDisposition)
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
              // 对齐 Go：Gin 的 `c.Redirect(302, url)` 会自动带上
              //   Content-Type: text/html; charset=utf-8
              //   Cache-Control: max-age=0, no-cache, no-store, must-revalidate
              //   Referrer-Policy: no-referrer
              // 而 Hono 的 `c.redirect()` 不带任何 Content-Type、且会写
              // `Content-Length: 0`。部分播放器（网易爆米花等）在拿到 302 时
              // 若缺少 Content-Type、或看到 Content-Length 为 0，会把它当成
              // 「空响应 / 无效响应」直接报「无法获取播放地址」，不会去跟随
              // Location。这里显式补齐与 Go 一致的头，保证行为逐字节对齐。
              c.header("Content-Type", "text/html; charset=utf-8")
              c.header(
                "Cache-Control",
                "max-age=0, no-cache, no-store, must-revalidate",
              )
              c.header("Referrer-Policy", "no-referrer")
              return c.body(null, 302, { Location: fileItem.raw_url })
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
