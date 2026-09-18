import { Hono } from "hono"
import { authUserFromReq, getOrInitUsers, verifyUserPassword } from "./auth"
import { can, PermissionBit } from "../pkg/permission"
import {
  listItems,
  getItem,
  putItem,
  makeDirectory,
  removeItems,
  moveItems,
  copyItems,
  getDriver,
} from "../internal/op/storage"
import { resolvePath } from "../internal/model/db"
import { buildWebDavPropfindResponse } from "../internal/webdav/webdav"
import { safeErrorMessage } from "../pkg/errs"

/**
 * WebDAV 协议服务（挂载于 /dav/*）。
 *
 * 认证：Basic Auth（用户名/密码）或 Bearer token（全局 token）。
 * 权限：WEBDAV_READ（读/列目录）与 WEBDAV_MANAGE（写/删/移动/复制）按位校验。
 * 支持方法：OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE / COPY。
 */

export const webdavRouter = new Hono()

/**
 * 当次请求的站点 origin（如 `https://tj518.de5.net`）。
 *
 * 用途：strm 驱动生成 `.strm` 文件内容时必须写出**绝对 URL**
 * （对齐 Go `common.GetApiUrl(ctx)`）。WebDAV 是网易爆米花 / Kodi / Infuse
 * 等第三方播放器的主要接入方式，它们把 `.strm` 内容当作**独立 URL** 去请求，
 * 没有站点上下文可推断相对路径 —— 缺了 origin 就只会写出 `/d/xxx.cas`
 * 这类相对路径，播放器直接报「webdav 地址错误」。
 */
const getRequestOrigin = (c: any): string | undefined => {
  try {
    return new URL(c.req.url).origin
  } catch {
    return undefined
  }
}

/**
 * 把可能是相对路径的地址补全为绝对 URL。
 *
 * WebDAV 客户端在跟随 302 时，对「相对 Location」的处理并不统一：RFC 7231
 * 规定按当前请求 URI 解析，于是 `/dav/电影/xxx.strm` 收到 `Location: /api/p/...`
 * 会被规范解析为站点根下的 `/api/p/...`（正确）；但网易爆米花等客户端会按
 * 「相对目录」拼接，得到 `/dav/api/p/...`（错误）。直接给绝对 URL 可同时
 * 满足两类实现，消除歧义。
 *
 * 已是绝对地址（http/https，多为 CDN 直链）时原样透传。
 */
const toAbsoluteUrl = (target: string, c: any): string => {
  const t = String(target || "")
  if (/^https?:\/\//i.test(t)) return t
  const origin = getRequestOrigin(c)
  if (!origin) return t
  return `${origin}${t.startsWith("/") ? "" : "/"}${t}`
}

const getStorageRequestContext = (c: any) => {
  // ⚠️ 此处**不能**因为缺少 executionCtx 就整体返回 undefined：
  // EdgeOne / Node 云函数运行时可能没有 `c.executionCtx`，那样会连 `env`
  // 与 `requestOrigin` 一起丢掉，导致 strm 驱动拿不到站点地址、退回相对路径。
  // 因此 waitUntil 与其余字段分开构造，各自降级。
  let waitUntil: ((p: Promise<unknown>) => void) | undefined
  try {
    const executionCtx = c.executionCtx
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      waitUntil = (p: Promise<unknown>) => executionCtx.waitUntil(p)
    }
  } catch {
    // 忽略：无 waitUntil 时由 op 层退化为直接 await 持久化
  }

  return {
    waitUntil,
    env: c.env, // 传递 env 用于请求级 KV 缓存复用
    // 请求级站点 origin：op 层会把它透传给 getDriver，
    // strm 驱动据此生成绝对 URL（对齐 Go common.GetApiUrl(ctx)）
    requestOrigin: getRequestOrigin(c),
  }
}

/** Basic Auth 或 Bearer token 认证，返回用户对象（未认证返回 null） */
async function webdavAuth(c: any): Promise<any> {
  const authHeader = c.req.header("Authorization") || ""
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.substring(6).trim())
      const idx = decoded.indexOf(":")
      if (idx < 0) return null
      const username = decoded.substring(0, idx)
      const password = decoded.substring(idx + 1)
      const { users } = await getOrInitUsers(c.env)
      const user = users.find((u: any) => u.username === username && !u.disabled)
      if (!user) return null
      // 空密码用户（guest）：Basic Auth 下若未提供密码则允许（与 AList 一致）
      if (!user.password) {
        return password === "" ? user : null
      }
      if (await verifyUserPassword(user, password)) return user
      return null
    } catch {
      return null
    }
  }
  if (authHeader.startsWith("Bearer ")) {
    const auth = await authUserFromReq(c)
    return auth ? auth.user : null
  }
  return null
}

/** 从 URL pathname 中剥离 /dav 前缀，得到虚拟文件路径 */
function davPathOf(c: any): string {
  const pathname = new URL(c.req.url).pathname
  let p = pathname.replace(/^\/dav/, "")
  if (!p) p = "/"
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

/**
 * WebDAV 的挂载前缀（本部署为 `/dav`）。
 *
 * ## 为什么 href 必须带这个前缀
 *
 * RFC 4918 §8.3：PROPFIND 响应里的 `<D:href>` 是**相对于服务器根的完整路径**，
 * 必须是客户端可以直接拿去请求的形式。客户端不会、也不应该帮你把挂载点拼回去。
 *
 * 此前 href 直接用了虚拟路径（`/strm/`），**丢掉了 `/dav` 前缀**，于是：
 *
 *   客户端挂载 https://站点/dav
 *   → PROPFIND /dav/          → href 给 `/strm`
 *   → 客户端认为子目录在「挂载点 + /strm」= /dav/strm
 *   → PROPFIND /dav/strm      → href 又给 `/strm/` 与 `/strm/移动`
 *   → 里面还有一项叫 `strm` → PROPFIND /dav/strm/strm → … **无限套娃**
 *
 * 表现为网易爆米花里「点目录一层一层套娃下去」，且**永远到不了真实文件**。
 * （`/移动` 同理，但它恰好是真实目录，readdir 能成功，所以症状不显眼。）
 *
 * 这里从原始请求 URL 动态推导前缀（而不是写死 "/dav"），使挂载点变更时
 * 无需再改本函数 —— 例如 `davPathOf("/dav/strm/") === "/strm/"`，
 * 而原始 pathname 去掉该虚拟路径后剩下的 `/dav` 就是前缀。
 */
function davPrefixOf(c: any, davPath: string): string {
  try {
    const pathname = new URL(c.req.url).pathname
    // ⚠️ 根目录（davPath === "/"）时**不能**用 endsWith 反推：
    // 空串是任何字符串的后缀，会得到「整个 pathname」这种荒谬结果。
    // 但也不能像早期版本那样直接跳过 —— 否则根目录请求会退回写死的 "/dav"，
    // 挂载点一变根目录 href 就错（子目录却对，故障极难定位）。
    //
    // 根目录的正确语义：把结尾的斜杠去掉，剩下的就是挂载前缀。
    //   /dav/     → /dav
    //   /webdav/  → /webdav
    if (davPath === "/" || davPath === "") {
      const trimmed = pathname.replace(/\/+$/, "")
      return trimmed || ""
    }
    // 非根：原始 pathname 可能是百分号编码的（/dav/%E7%A7%BB%E5%8A%A8），
    // 而 davPath 是解码后的（/移动），按长度裁切不可靠 ——
    // 改为裁掉「原始串里对应虚拟路径的那一段」。
    // 用编码后的形式再试一次，兼容中文路径。
    const candidates = [davPath, encodeDavPath(davPath), davPath.endsWith("/") ? davPath.slice(0, -1) : davPath + "/", encodeDavPath(davPath.endsWith("/") ? davPath.slice(0, -1) : davPath + "/")]
    for (const cnd of candidates) {
      if (cnd && pathname.endsWith(cnd)) {
        return pathname.slice(0, pathname.length - cnd.length).replace(/\/+$/, "")
      }
    }
    // 回退：按固定挂载点处理
    return "/dav"
  } catch {
    return "/dav"
  }
}

/**
 * 把虚拟路径逐段百分号编码，保留 `/` 分隔符。
 *
 * ## 为什么不直接用 encodeURIComponent
 *
 * `encodeURIComponent("/移动/")` 会把斜杠也编成 `%2F`，路径结构就没了；
 * 而完全不编码又会出现**混合编码**：父路径 `/dav/移动/` 里的中文是裸的，
 * 子项名却被 `encodeURIComponent` 编成了 `%E7%A7%BB%E5%8A%A8`，客户端拿到
 * `/dav/移动/%E7%A7%BB%E5%8A%A8` 这种半编码串，部分实现会解析失败。
 *
 * 所以逐段编码、用 `/` 还原。
 *
 * ⚠️ xml.ts 里对**子项名**另有 `encodeURIComponent`，所以本函数只需处理
 * 父路径；重复编码同一段也不会出错（`%` 本身不在需转义字符集里，
 * 但 encodeURIComponent 会把它变成 %25 —— 故此处**不能**对已编码段二次调用）。
 */
function encodeDavPath(p: string): string {
  return String(p || "/")
    .split("/")
    .map((seg) => {
      // 已是合法编码段（形如 %XX 或 %XX%XX…）则原样保留，避免二次编码
      if (/^(?:%[0-9A-Fa-f]{2})+$/.test(seg)) return seg
      return encodeURIComponent(seg).replace(/%2F/gi, "/")
    })
    .join("/")
}

/**
 * 取虚拟 `.strm` 文件的文本内容；非 `.strm` 时返回 `null`（调用方回退到 302）。
 *
 * 对齐 Go `(d *Strm) Link` 分支 ①：虚拟 `.strm` 的「内容」就是那行播放 URL。
 * WebDAV 播放器（网易爆米花等）读 `.strm` 时期望拿到这行文本，
 * 拿到后自行请求它；若返回 302 到自身则必然失败（详见 GET 分支注释）。
 */
async function getStrmContent(
  davPath: string,
  ctx: any,
): Promise<string | null> {
  if (!/\.strm$/i.test(davPath)) return null
  try {
    const resolved = await resolvePath(davPath, ctx?.env)
    if (resolved.isVirtual || !resolved.physical) {
      console.log(`[webdav] strmContent skip: virtual/ no physical for '${davPath}'`)
      return null
    }
    if (String(resolved.storage?.driver || "").toLowerCase() !== "strm") {
      console.log(
        `[webdav] strmContent skip: driver='${resolved.storage?.driver}' for '${davPath}'`,
      )
      return null
    }
    const driver: any = await getDriver(
      resolved.storage.driver,
      resolved.storage,
      ctx?.requestOrigin,
    )
    if (typeof driver?.strmContent !== "function") {
      console.log(`[webdav] strmContent skip: no strmContent method`)
      return null
    }
    // ⚠️ 必须传 `resolved.physical`（存储内相对路径，如 `/移动/...`），
    // **不是** davPath（带挂载点的全路径 `/strm/移动/...`）。
    // 与 op 层调用驱动的方式一致：`driver.list(virtualPath, resolved.physical)`，
    // 驱动只认第二个参数。
    const out = await driver.strmContent(resolved.physical)
    console.log(
      `[webdav] strm content '${resolved.physical}' -> ${out ? out.slice(0, 90) : "null"}`,
    )
    return out
  } catch (e: any) {
    console.error(`[webdav] strmContent error for '${davPath}':`, e?.message)
    return null
  }
}

/** 拆分虚拟路径为 { dir, name } */
function splitPath(p: string): { dir: string; name: string } {
  const clean = p.startsWith("/") ? p : "/" + p
  const parts = clean.split("/").filter(Boolean)
  const name = parts.pop() || ""
  const dir = "/" + parts.join("/")
  return { dir, name }
}

webdavRouter.all("/*", async (c) => {
  const user = await webdavAuth(c)
  if (!user) {
    return c.text("Unauthorized", 401, {
      "WWW-Authenticate": 'Basic realm="OpenList"',
    })
  }
  const canRead = can(user, PermissionBit.WEBDAV_READ)
  const canManage = can(user, PermissionBit.WEBDAV_MANAGE)
  if (!canRead && !canManage) {
    return c.text("Forbidden", 403)
  }

  const method = c.req.method.toUpperCase()
  const davPath = davPathOf(c)
  const ctx = getStorageRequestContext(c)

  try {
    switch (method) {
      case "OPTIONS": {
        c.header("DAV", "1, 2")
        c.header("Allow", "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY")
        c.header("MS-Author-Via", "DAV")
        return c.body(null, 200)
      }

      case "PROPFIND": {
        if (!canRead) return c.text("Forbidden", 403)
        const depth = c.req.header("Depth") || "1"
        const res = await listItems(davPath, ctx)
        const items = (res.content || []).map((it: any) => ({
          name: it.name,
          size: it.size || 0,
          isFolder: !!it.is_dir,
          modified: it.modified || new Date().toISOString(),
        }))
        // ⚠️ href 必须带挂载前缀（`/dav`），否则客户端会把子目录当成
        // 「挂载点 + href」去请求，导致无限套娃（详见 davPrefixOf 注释）。
        const prefix = davPrefixOf(c, davPath)
        const virtual = davPath === "/" ? "/" : davPath.endsWith("/") ? davPath : davPath + "/"
        const href = `${prefix}${encodeDavPath(virtual)}`
        const xml = buildWebDavPropfindResponse(href, items)
        return c.body(xml, depth === "0" ? 207 : 207, {
          "Content-Type": "application/xml; charset=utf-8",
        })
      }

      case "GET":
      case "HEAD": {
        if (!canRead) return c.text("Forbidden", 403)
        const { item, rawUrl } = await getItem(davPath, ctx)
        if (!item) return c.text("Not found", 404)
        if (item.is_dir) return c.text("Is a directory", 400)

        // ── 虚拟 `.strm` 文件：必须返回**文本内容**，不能 302 ──────────────
        //
        // 对齐 Go `(d *Strm) Link` 的分支 ①：`.strm` 是虚拟文件，
        // 内容是「一行播放 URL」。播放器读到后自行请求那行 URL。
        //
        // ⚠️ 此前这里对所有文件一律 302 到 `/api/p/...`，对 `.strm` 是致命的：
        //   302 Location 仍以 `.strm` 结尾 → 自指 → 且该地址需要签名校验，
        //   Location 里的 sign 校验不过 → **401** →
        //   网易爆米花弹「网络异常，请确保网络正常且 WebDAV 地址正确后重试」。
        const strmText = await getStrmContent(davPath, ctx)
        if (strmText !== null) {
          return c.body(strmText, 200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(new TextEncoder().encode(strmText).length),
          })
        }

        // 重定向到 rawRouter（/api/p/*）实际下载；rawRouter 已处理所有驱动的
        // 下载协议（proxy/redirect/stream + Range + SSRF 防护）
        const target =
          rawUrl || `/api/p${davPath.startsWith("/") ? "" : "/"}${davPath}`
        // ⚠️ 必须补成**绝对 URL**：rawUrl 由 op 层产出的是站点根路径
        // （`/api/p/...`），而 WebDAV 挂在 `/dav` 下。部分客户端（含网易爆米花）
        // 会按「相对当前目录」解析 302 的 Location，从而拼出
        // `/dav/api/p/...` → 404，表现为「webdav 地址错误」。
        return c.redirect(toAbsoluteUrl(target, c), 302)
      }

      case "PUT": {
        if (!canManage) return c.text("Forbidden", 403)
        const buffer = Buffer.from(await c.req.arrayBuffer())
        await putItem(davPath, buffer, ctx)
        return c.body(null, 201)
      }

      case "MKCOL": {
        if (!canManage) return c.text("Forbidden", 403)
        await makeDirectory(davPath, ctx)
        return c.body(null, 201)
      }

      case "DELETE": {
        if (!canManage) return c.text("Forbidden", 403)
        const { dir, name } = splitPath(davPath)
        await removeItems(dir, [name], ctx)
        return c.body(null, 204)
      }

      case "MOVE": {
        if (!canManage) return c.text("Forbidden", 403)
        const destRaw = c.req.header("Destination") || ""
        let dest = destRaw
        try {
          dest = decodeURIComponent(new URL(destRaw, c.req.url).pathname).replace(/^\/dav/, "")
        } catch {}
        const src = splitPath(davPath)
        const dst = splitPath(dest)
        await moveItems(src.dir, dst.dir, [src.name], ctx)
        return c.body(null, 201)
      }

      case "COPY": {
        if (!canManage) return c.text("Forbidden", 403)
        const destRaw = c.req.header("Destination") || ""
        let dest = destRaw
        try {
          dest = decodeURIComponent(new URL(destRaw, c.req.url).pathname).replace(/^\/dav/, "")
        } catch {}
        const src = splitPath(davPath)
        const dst = splitPath(dest)
        await copyItems(src.dir, dst.dir, [src.name], ctx)
        return c.body(null, 201)
      }

      case "LOCK":
      case "UNLOCK":
        // 简化实现：声明不支持锁，客户端通常可继续无锁操作
        return c.text("Locking not supported", 405)

      default:
        return c.text("Method Not Allowed", 405)
    }
  } catch (e: any) {
    const msg = safeErrorMessage(e)
    if (msg.includes("not found") || msg.includes("storage not found")) {
      return c.text("Not Found", 404)
    }
    return c.text(msg, 500)
  }
})
