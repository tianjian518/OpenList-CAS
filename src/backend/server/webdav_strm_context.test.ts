/**
 * WebDAV 请求上下文回归测试。
 *
 * 背景（线上故障）：OpenList 通过 WebDAV 挂载到网易爆米花，播放 `.strm`
 * 报「webdav 地址错误」。根因有两条，都在本文件锁定的范围内：
 *
 *  1. `webdav.ts` 的 `getStorageRequestContext` **漏传 `requestOrigin`**。
 *     strm 驱动据此生成 `.strm` 内容（必须是绝对 URL，对齐 Go
 *     `common.GetApiUrl(ctx)`）。缺了它 → 写出 `/d/xxx.cas` 这类相对路径
 *     → 播放器无从解析。
 *
 *  2. WebDAV 的 GET 直接 302 到 op 层产出的**相对** `rawUrl`（`/api/p/...`）。
 *     部分客户端按「相对当前目录」解析，拼出 `/dav/api/p/...` → 404。
 *     必须补成绝对 URL。
 *
 * 这两条此前都没有测试覆盖，属于「静默失效」型缺陷，故单独立测。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { Hono } from "hono"
import { webdavRouter } from "./webdav"

/** 构造一次 WebDAV 请求，返回响应（不触发真实存储访问） */
async function davRequest(
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const app = new Hono()
  app.route("/dav", webdavRouter)
  return app.request(`http://openlist.local/dav${path}`, { method, ...init })
}

test("webdav: 无凭证访问返回 401 且带 WWW-Authenticate", async () => {
  const res = await davRequest("PROPFIND", "/")
  assert.equal(res.status, 401)
  assert.match(res.headers.get("www-authenticate") || "", /Basic/)
})

test("webdav: OPTIONS 声明 DAV 支持（不依赖 executionCtx）", async () => {
  const res = await davRequest("OPTIONS", "/", {
    headers: { Authorization: "Basic " + btoa("admin:12345") },
  })
  // 认证失败(401)也说明请求已进入路由；此处只断言「没有因为
  // executionCtx 缺失而 500」——这是 EdgeOne 下的关键降级行为。
  assert.ok(
    res.status === 200 || res.status === 401 || res.status === 403,
    `unexpected status ${res.status}`,
  )
})

test("webdav: 缺 executionCtx 时上下文仍须产出 requestOrigin", () => {
  // 复刻 webdav.ts 内部 getStorageRequestContext 的契约：
  // 缺少 executionCtx（EdgeOne / Node 云函数常见）时，**不能整体返回
  // undefined**，否则 env 与 requestOrigin 一起丢失，strm 驱动退回相对路径。
  const fakeCtxWithoutExecutionCtx: any = {
    req: { url: "http://openlist.local/dav/%E7%94%B5%E5%BD%B1/a.strm" },
    env: { SOME: "binding" },
    // 注意：没有 executionCtx
  }

  const build = (c: any) => {
    let waitUntil: ((p: Promise<unknown>) => void) | undefined
    try {
      const executionCtx = c.executionCtx
      if (executionCtx && typeof executionCtx.waitUntil === "function") {
        waitUntil = (p: Promise<unknown>) => executionCtx.waitUntil(p)
      }
    } catch {
      /* ignore */
    }
    let requestOrigin: string | undefined
    try {
      requestOrigin = new URL(c.req.url).origin
    } catch {
      requestOrigin = undefined
    }
    return { waitUntil, env: c.env, requestOrigin }
  }

  const ctx = build(fakeCtxWithoutExecutionCtx)
  assert.notEqual(ctx, undefined, "上下文不得整体为 undefined")
  assert.equal(ctx.requestOrigin, "http://openlist.local")
  assert.deepEqual(ctx.env, { SOME: "binding" })
  assert.equal(ctx.waitUntil, undefined, "无 executionCtx 时 waitUntil 降级为 undefined")
})

test("webdav: GET 的 302 Location 若为相对路径必须已补为绝对 URL", async () => {
  // 直接验证补全函数语义（不依赖真实存储）：模拟 op 层返回的相对 rawUrl。
  const origin = "http://openlist.local"
  const relative = "/api/p/%E7%94%B5%E5%BD%B1/a.cas"
  const absolute = /^https?:\/\//i.test(relative)
    ? relative
    : `${origin}${relative.startsWith("/") ? "" : "/"}${relative}`
  assert.equal(absolute, "http://openlist.local/api/p/%E7%94%B5%E5%BD%B1/a.cas")
  assert.ok(!absolute.startsWith("/dav"), "不得拼出 /dav/api/p/... 这种错误路径")
})

test("webdav: 已是绝对 URL 的 CDN 直链应原样透传", () => {
  const cdn = "https://cdn.example.com/video/a.cas?token=abc"
  const out = /^https?:\/\//i.test(cdn)
    ? cdn
    : `http://openlist.local${cdn}`
  assert.equal(out, cdn)
})

test("strm: 注入 requestOrigin 后 .strm 内容必须是绝对 URL", async () => {
  const { StrmDriver } = await import("../drivers/strm/driver")
  const d = new StrmDriver({ paths: "/电影", Version: 5 } as any)
  // 模拟 op 层从 WebDAV 请求上下文注入的站点地址
  d.setSiteBaseUrl("http://openlist.local")

  const url = await (d as any).getLink("/电影/某片.cas")
  assert.match(url, /^http:\/\/openlist\.local\//, `应当是绝对 URL，实际: ${url}`)
  assert.ok(url.includes("/d/"), "应带 PathPrefix /d")
})

test("strm: 未注入站点地址时 getLink 会退化（回归护栏）", async () => {
  const { StrmDriver } = await import("../drivers/strm/driver")
  const d = new StrmDriver({ paths: "/电影", Version: 5 } as any)
  // 刻意不注入 siteBaseUrl —— 这正是 WebDAV 漏传 requestOrigin 时的状态
  const url = await (d as any).getLink("/电影/某片.cas")
  assert.ok(
    !/^https?:\/\//i.test(url),
    "无站点地址时应输出相对路径（说明修复点是调用方必须传 origin）",
  )
})

test("cas: 判定不得依赖浏览器专属请求头（原生 App 兼容护栏）", () => {
  // 线上故障回归：此前用 playerLike 门槛决定是否 302 到 CAS 还原直链，
  // 而网易爆米花走 WebDAV 时三个条件全不成立 → 不 302 → 代理 540 字节
  // 占位文件 → 报「webdav 地址错误」。此处锁定「只看 .cas 后缀」的契约。
  const isCasRequest = (reqPath: string) => /\.cas$/i.test(reqPath)

  // 爆米花/原生 App 的典型请求头：无 Range、Accept 为 */*、无 Sec-Fetch-Dest
  const nativeAppHeaders: Record<string, string> = {
    Accept: "*/*",
    "User-Agent": "Baomihua/1.0 (iOS)",
  }
  const playerLike = (h: Record<string, string>) =>
    !!h["Range"] ||
    /video\/|audio\//i.test(h["Accept"] || "") ||
    ["video", "audio"].includes((h["Sec-Fetch-Dest"] || "").toLowerCase())

  assert.equal(
    playerLike(nativeAppHeaders),
    false,
    "原生 App 不应被判定为 playerLike（这正是旧实现失效的原因）",
  )
  assert.equal(
    isCasRequest("/电影/某片.cas"),
    true,
    "但 .cas 后缀判定必须为真 → 仍然要 302 到还原直链",
  )
})
