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
} from "../internal/op/storage"
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
        const href = davPath === "/" ? "/" : davPath.endsWith("/") ? davPath : davPath + "/"
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
