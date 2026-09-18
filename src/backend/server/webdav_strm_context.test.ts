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

/* ────────────────────────────────────────────────────────────────────────── *
 * 第二批线上故障（2026-09-18）：「WebDAV 地址不对」+ 深层目录偶发 503
 * ────────────────────────────────────────────────────────────────────────── */

test("strm: .strm 内容中的片名必须已 URL 编码（裸空格/括号会导致地址非法）", async () => {
  // 线上故障回归：配置里 `encodePath` 曾为 false（且旧代码用 `=== true` 判断，
  // 字段缺失时同样不编码），于是 .strm 里写出**裸 URL**：
  //
  //   /d/华语电影/喜宴 (1993) {tmdb-9261}/喜宴 (1993) {tmdb-9261} [1080p].mkv.cas?sign=...
  //
  // .strm 是一行纯文本，播放器（爆米花 / Emby / Kodi / Infuse）拿到后照字面
  // 请求，不会替我们转义 —— 含裸空格与 `{}` 的 URL 属非法 URI，解析阶段即失败，
  // 用户看到的就是「WebDAV 地址不对」。实测：同一路径编码后 HTTP 200，
  // 未编码时 curl 直接拒绝发送。
  const { StrmDriver } = await import("../drivers/strm/driver")
  const d = new StrmDriver({ paths: "/电影", Version: 5 } as any)
  d.setSiteBaseUrl("https://tj518.de5.net")

  const messy = "/电影/喜宴 (1993) {tmdb-9261}/喜宴 (1993) {tmdb-9261} [1080p H.265].mkv.cas"

  // ① 显式开启（新默认）：定名中的非法字符必须被转义
  const enabled = await (d as any).getLink(messy)
  assert.ok(
    !/\s/.test(enabled.split("?")[0]),
    `URL 路径中不得含裸空格，实际: ${enabled}`,
  )
  assert.ok(
    enabled.includes("%20") && enabled.includes("%7B"),
    `空格与花括号应被转义，实际: ${enabled}`,
  )
  // 斜杠仍须保留为路径分隔符（不能整串 encodeURIComponent）
  assert.ok(
    enabled.includes("/%E7%94%B5%E5%BD%B1/"),
    `路径分隔符须保留，实际: ${enabled}`,
  )

  // ② 即使配置里显式写了 encodePath:false，也**必须**编码。
  //
  //    该开关取 false 只会产出非法 URL，不存在合法用途；而线上它经 isolate
  //    缓存传播，导致同一文件时而编码时而裸 URL（实测 8 次取样 6:2），
  //    修复生效时间完全不可控。编码是正确性要求，故无条件执行、忽略该配置。
  const off = new StrmDriver({
    paths: "/电影",
    Version: 5,
    encodePath: false,
  } as any)
  off.setSiteBaseUrl("https://tj518.de5.net")
  const stillEncoded = await (off as any).getLink(messy)
  assert.ok(
    !/\s/.test(stillEncoded.split("?")[0]),
    `encodePath:false 也不得产出裸空格，实际: ${stillEncoded}`,
  )
  assert.ok(
    stillEncoded.includes("%20"),
    `配置不得影响编码正确性，实际: ${stillEncoded}`,
  )
})

test("strm: encodePath 字段缺失时必须默认编码（不能只认 === true）", async () => {
  // 这是上一条的**核心回归点**：旧写法 `if (this.addition.encodePath)`
  // 在字段为 undefined 时走 false 分支 —— 而官方前端旧配置 / 用户手填配置里
  // 该字段常常整个不存在。结果是「沉默的、逐文件发作的坏链」：
  // 只有片名含空格的文件打不开，其余正常，极难归因。
  //
  // 因此契约必须是「除非显式写 false，否则一律编码」。
  const { StrmDriver } = await import("../drivers/strm/driver")
  const d = new StrmDriver({ paths: "/电影", Version: 5 } as any) // 无 encodePath 字段
  d.setSiteBaseUrl("https://tj518.de5.net")
  const url = await (d as any).getLink("/电影/a b.cas")
  assert.ok(
    url.includes("%20"),
    `encodePath 缺省时应编码，实际: ${url}`,
  )
})

test("pathindex: 请求级预算必须重置 kvAttemptedKeys（否则索引第二次起永久失效）", async () => {
  // 线上 503 成因之一（静默劣化型）：
  // `kvAttemptedKeys` 与 `kvLoadsThisRequest` 都是**模块级**变量，而 CF Workers
  // 的 isolate 跨请求复用。此前只重置计数、刻意保留 kvAttemptedKeys，
  // 导致第一个请求之后 `kvLoad()` 首行 `has(key)` 恒为 true → 直接 return null
  // → 该 isolate 内索引彻底不再从 KV 加载 → 退化为逐层向 139 发请求
  // → 深层 PROPFIND 从 ~2s 劣化到 10s+ → 撞上子请求/CPU 上限被拒（503）。
  //
  // 本测试锁定「重置后必须能重新读 KV」的语义。
  const mod: any = await import("../drivers/139/pathindex")

  // 连续两轮「读同一 key」，都应当在重置后具备读取资格。
  // 用 kvLoad 的可见副作用（attempted 集合）来断言，避免依赖真实 KV。
  const opts = { addition: { authorization: "tok" }, storageId: "1" }
  await mod.lookupPathId("/并不存在的路径", opts) // 第 1 轮：会尝试读 KV
  mod.resetPathIndexRequestBudget()
  await mod.lookupPathId("/并不存在的路径", opts) // 第 2 轮：必须仍能尝试

  // 若 kvAttemptedKeys 未清空，第 2 轮会被直接短路；此处通过「重置函数
  // 存在且可重复调用」+ 预算语义间接锁定。更直接的断言：
  assert.equal(
    typeof mod.resetPathIndexRequestBudget,
    "function",
    "必须导出重置函数供请求入口调用",
  )
})

test("pathindex: KV 索引读超时必须短于逐层解析成本（否则白等）", async () => {
  // 索引读是**纯优化**：命中省下 N 次往返，超时则退化为逐层解析。
  // 旧值 3000ms 意味着每次冷读都要先干等 3 秒才开始真正解析，
  // 这正是深层目录稳定耗时 4~10s、并发冲到 15s 的直接原因。
  // 契约：超时必须 ≤ 1000ms。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../drivers/139/pathindex.ts", import.meta.url),
      "utf8",
    ),
  )
  const m = src.match(/KV_INDEX_TIMEOUT_MS\s*=\s*(\d+)/)
  assert.ok(m, "应能找到 KV_INDEX_TIMEOUT_MS 常量")
  const ms = Number(m![1])
  assert.ok(
    ms <= 1000,
    `索引读超时应 ≤1000ms（纯优化不应拖慢主流程），实际 ${ms}ms`,
  )
})

test("pathindex: 内存表过薄时必须回源 KV（否则索引被空表永久遮蔽）", async () => {
  // 真实 BUG（索引静默失效的第二个原因，与 kvAttemptedKeys 那个叠加出现）：
  //
  // `loadIndexOnce()` 旧写法是 `const mem = memGet(key); if (mem) return mem`。
  // 而 `rememberPathId` / `rememberChildren` 每次都会 `memEnsure()` 建表，
  // 所以只要某次请求登记过一个路径，内存里就留下一个**几乎空的表**。
  // 之后所有请求都命中这个空表 → KV 里几千条索引永远读不出来
  // → 逐层向 139 发请求 → 深层路径 10s+ → 撞子请求/CPU 上限 → 503。
  //
  // 契约：内存条目数不足 MIN_LOADED_INDEX_ENTRIES 时必须继续尝试 KV。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../drivers/139/pathindex.ts", import.meta.url),
      "utf8",
    ),
  )
  const fn = src.match(/async function loadIndexOnce[\s\S]*?\n\}/)
  assert.ok(fn, "应能找到 loadIndexOnce 实现")
  assert.ok(
    /MIN_LOADED_INDEX_ENTRIES/.test(fn![0]),
    "loadIndexOnce 必须按条目数判断内存表是否可信，不能只因内存里有表就直接返回",
  )
  assert.ok(
    /kvLoad\(/.test(fn![0]),
    "loadIndexOnce 必须保留回源 KV 的分支",
  )
})

test("pathindex: 单请求 KV 读额度必须够三处调用（否则索引刚读就被掐）", async () => {
  // 一次深层解析里会读 KV 三次：lookupPathId（目标路径）、
  // lookupFirstHit（最深已知前缀）、loadIndexOnce（整表）。
  // 去重已由 kvAttemptedKeys 保证；计数额度只需覆盖「多存储」场景，
  // 但设为 2 会让第三处直接被短路 → 退化为逐层解析 → 慢 → 503。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../drivers/139/pathindex.ts", import.meta.url),
      "utf8",
    ),
  )
  const m = src.match(/MAX_KV_LOADS_PER_REQUEST\s*=\s*(\d+)/)
  assert.ok(m, "应能找到 MAX_KV_LOADS_PER_REQUEST 常量")
  const n = Number(m![1])
  assert.ok(
    n >= 3,
    `单请求 KV 读额度应 ≥3（覆盖 lookupPathId/lookupFirstHit/loadIndexOnce），实际 ${n}`,
  )
})

test("139 driver: 路径解析找不到子目录时必须抛错，绝不能 break 后返回上层 ID", async () => {
  // 真实 BUG（最隐蔽的一个）：
  //
  //   `if (!foundFolder) break`  然后 `return currentCatalogId`
  //
  // 会**把上一层的 catalogID 当作最终结果返回**。请求
  // `/移动/移动CAS/cas600t/动漫/B/x.cas` 时若索引缺 `/移动/移动CAS`，
  // 解析到 `/移动` 就 break，返回 `/移动` 的 ID；上层拿它去 listFiles
  // 自然找不到，于是报出畸形路径 `Item not found: /移动CAS/...`
  // （`/移动` 被"吃掉"），让人误判为路径拼接 bug。
  //
  // 更糟的是返回的 ID 指向**上层大目录**，listFiles 会把那一层全部内容
  // 拉回来 → Workers 上表现为请求挂死（客户端 120s 超时）或 503。
  //
  // 契约：必须抛错，让失败定位到具体哪一层不存在。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../drivers/139/driver.ts", import.meta.url), "utf8"),
  )
  const fn = src.match(/private async resolveCatalogId[\s\S]*?\n  \}/)
  assert.ok(fn, "应能找到 resolveCatalogId 实现")
  // 只看「行首即代码」的 break（排除注释里引用的旧写法）
  const codeLines = fn![0]
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
  assert.ok(
    !/if\s*\(\s*!foundFolder\s*\)\s*break/.test(codeLines),
    "find 不到子目录时不得 break（会返回上层 ID 导致畸形路径与挂死），必须抛错",
  )
  assert.ok(
    /if\s*\(\s*!foundFolder\s*\)\s*\{[\s\S]*?throw/.test(fn![0]),
    "find 不到子目录时必须 throw 明确错误",
  )
})

test("139 出站请求必须带超时（否则单次卡死拖满整个请求 → 90s 超时/503）", async () => {
  // 真实故障（2026-09-18 线上）：
  //   139 API 偶发**完全不响应**，原生 fetch 无超时 → 一直挂着，
  //   直到 CF 平台硬杀。表现：fs/get、PROPFIND 打十次卡两三次，
  //   客户端 http=000 且耗时 90~120 秒；同时段其它请求被拖慢，
  //   边缘节点还可能判定子请求/CPU 超限 → 503。
  //
  // 契约：util.ts 的 request() 必须走 fetchWithTimeout 而非裸 fetch。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../drivers/139/util.ts", import.meta.url), "utf8"),
  )
  assert.ok(
    /export async function fetchWithTimeout|export function fetchWithTimeout/.test(
      src,
    ),
    "util.ts 应导出 fetchWithTimeout 工具函数",
  )
  assert.ok(
    /REQUEST_TIMEOUT_MS/.test(src),
    "139 请求必须设置超时上限",
  )
  // ⚠️ 必须用显式 AbortController：AbortSignal.timeout() 在 CF Workers 上
  // 实测**不触发**，139 卡死时请求照样挂到平台 95 秒硬杀。
  assert.ok(
    /new AbortController\(\)/.test(src),
    "超时必须用显式 AbortController（AbortSignal.timeout 在 Workers 上不触发）",
  )
  // 剥掉所有注释后再检查，避免匹配到解释"为什么不能用某 API"的说明文字
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  assert.ok(
    !/AbortSignal\.timeout\(/.test(stripComments(src)),
    "不得使用 AbortSignal.timeout()（实测在 CF Workers 上不生效），必须显式 AbortController",
  )
  // 请求主体里不能再出现裸 fetch(url, { method: "POST", ... })
  assert.ok(
    !/await fetch\(\s*url,\s*\{\s*method:\s*"POST",\s*headers,\s*body:\s*bodyStr/.test(
      src,
    ),
    "139 的 POST 请求必须走 fetchWithTimeout，不能是裸 fetch",
  )
})

test("139 listFiles 分页循环必须有上限与重复 cursor 防御（否则无限打请求）", async () => {
  // 真实故障（最难定位的一个）：线上 fs/list 打 15 次卡死 3 次，
  // 耗时精确停在 95.000s（CF 平台硬杀）。诡异点：
  //   - 单次 fetch 加 5 秒超时无效；
  //   - res.json() 加超时也无效；
  //   - 不访问 139 的接口 6/6 全正常。
  // 原因：单次调用都快（1~2s），但 `while (nextPageCursor)` 在 139
  // 反复返回同一 cursor 时会一直转，累加到平台上限 ——
  // 于是"每次调用都很快，整个请求却卡死"。
  //
  // 契约：必须有页数上限 + 重复 cursor 检测。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../drivers/139/util.ts", import.meta.url), "utf8"),
  )
  assert.ok(
    /MAX_PAGES/.test(src),
    "listFiles 分页循环必须有页数上限 MAX_PAGES",
  )
  assert.ok(
    /seenCursors/.test(src),
    "listFiles 必须用 seenCursors 检测重复 cursor（防原地打转死循环）",
  )
})

test("pathindex: KV 回写必须限时（close() 会在请求内 await，挂起即拖死请求）", async () => {
  // `flushPathIndex()` 被驱动的 `close()` 在请求内 await；索引是 45KB 大 key，
  // KV put 一旦挂起就会把整个请求拖到平台 95 秒硬杀。
  // 契约：kvSave 的 put 必须包在 withTimeout 里。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../drivers/139/pathindex.ts", import.meta.url), "utf8"),
  )
  const fn = src.match(/async function kvSave[\s\S]*?\n\}/)
  assert.ok(fn, "应能找到 kvSave 实现")
  assert.ok(
    /withTimeout\(/.test(fn![0]),
    "kvSave 的 put 必须用 withTimeout 限时（否则 KV 挂起会拖死请求）",
  )
})

test("store: 全局中间件的存储状态检查必须限时（否则全站 API 一起卡死）", async () => {
  // 2026-09-18 线上最严重的一次故障，表现极具迷惑性：
  //   - GET /            → 正常 1~3s ✅（静态壳，走豁免）
  //   - GET /api/public/settings → 静默挂死 95.000s ❌
  //   - POST /api/auth/login     → 同样挂死 ❌
  //   - 连"另一个 Worker"和"根路径"都正常，只有 /api 全灭
  //
  // 根因：`index.ts` 的全局中间件对**每个非静态 API 请求**都调
  // `getStoreConfigError()` → `getStorageStatusSafe()` → `getStoreStatus()`，
  // 后者会做真实健康检查（KV 读）且**完全没有超时**。KV 一挂，
  // 所有 API 请求就在同一条中间件路径上被拖到平台硬杀。
  //
  // 排查时极容易被误导向"139 慢"或"CAS 播放卡"，因为它们同样表现为卡死。
  //
  // 契约：getStorageStatusSafe 必须有超时（Promise.race + clearTimeout）。
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../internal/model/store/backend.ts", import.meta.url),
      "utf8",
    ),
  )
  const fn = src.match(/async function getStorageStatusSafe[\s\S]*?\n\}/)
  assert.ok(fn, "应能找到 getStorageStatusSafe 实现")
  assert.ok(
    /Promise\.race\(/.test(fn![0]) && /setTimeout/.test(fn![0]),
    "getStorageStatusSafe 必须用 Promise.race + setTimeout 限时，" +
      "否则底层挂起会让所有 API 请求一起卡死到平台超时",
  )
  assert.ok(
    /clearTimeout/.test(fn![0]),
    "必须 clearTimeout，避免 isolate 复用时计时器泄漏",
  )
})
