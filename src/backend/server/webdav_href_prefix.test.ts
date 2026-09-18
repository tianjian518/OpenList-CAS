/**
 * WebDAV PROPFIND href 必须携带挂载前缀（`/dav`）—— 回归测试
 *
 * ## 复现的线上故障
 *
 * 用户把 WebDAV 挂到「网易爆米花」，点目录会**一层一层无限套娃**：
 *
 *   strm → strm → strm → strm → …
 *
 * 根因：PROPFIND 返回的 `<D:href>` 用了**虚拟路径**（`/strm/`），
 * **丢掉了 `/dav` 挂载前缀**。RFC 4918 §8.3 要求 href 是相对服务器根的
 * 完整路径，客户端不会替你补挂载点，于是：
 *
 *   挂载 https://站点/dav
 *   → PROPFIND /dav/       → href `/strm`
 *   → 客户端请求 /dav/strm  → href 又是 `/strm/` + `/strm/移动`
 *   → 里面还有一项叫 strm  → /dav/strm/strm → … 无限循环
 *
 * 实测（修复前）：
 *   /dav/strm           → href /strm/、/strm/移动
 *   /dav/strm/strm      → href /strm/strm/
 *   /dav/strm/strm/strm → href /strm/strm/strm/
 *
 * 该故障**不会报错**，只是把目录树变成无限深，属静默型缺陷，故单独立测。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * 复刻 `webdav.ts` 的 `davPrefixOf`：从原始 pathname 反推挂载前缀。
 * 不写死 "/dav"，以便挂载点变化时无需改逻辑。
 */
function davPrefixOf(pathname: string, davPath: string): string {
  if (davPath === "/" || davPath === "") {
    const trimmed = pathname.replace(/\/+$/, "")
    return trimmed || ""
  }
  const candidates = [
    davPath,
    encodeDavPath(davPath),
    davPath.endsWith("/") ? davPath.slice(0, -1) : davPath + "/",
    encodeDavPath(davPath.endsWith("/") ? davPath.slice(0, -1) : davPath + "/"),
  ]
  for (const cnd of candidates) {
    if (cnd && pathname.endsWith(cnd)) {
      return pathname.slice(0, pathname.length - cnd.length).replace(/\/+$/, "")
    }
  }
  return "/dav"
}

/** 复刻 `encodeDavPath`：逐段百分号编码，保留 / 分隔 */
function encodeDavPath(p: string): string {
  return String(p || "/")
    .split("/")
    .map((seg) => {
      if (/^(?:%[0-9A-Fa-f]{2})+$/.test(seg)) return seg
      return encodeURIComponent(seg).replace(/%2F/gi, "/")
    })
    .join("/")
}

/** 复刻 PROPFIND 里 href 的组装 */
function davHref(pathname: string, davPath: string): string {
  const prefix = davPrefixOf(pathname, davPath)
  const virtual =
    davPath === "/" ? "/" : davPath.endsWith("/") ? davPath : davPath + "/"
  return `${prefix}${encodeDavPath(virtual)}`
}

/** 复刻 `pkg/xml.ts` 里子项 href 的拼接 */
function childHref(parentHref: string, name: string): string {
  return `${parentHref}${parentHref.endsWith("/") ? "" : "/"}${encodeURIComponent(name)}`
}

test("webdav href: 必须带 /dav 前缀（核心回归点）", () => {
  // 修复前返回 `/strm/`，客户端拼成 /dav/strm 后再次列出自己 → 套娃
  assert.equal(davHref("/dav/strm", "/strm"), "/dav/strm/")
  assert.notEqual(davHref("/dav/strm", "/strm"), "/strm/")
})

test("webdav href: 根目录带前缀", () => {
  assert.equal(davHref("/dav/", "/"), "/dav/")
  assert.equal(davHref("/dav", "/"), "/dav/")
})

test("webdav href: 带不带尾斜杠的请求得到同一 href", () => {
  assert.equal(davHref("/dav/strm", "/strm"), davHref("/dav/strm/", "/strm/"))
})

test("webdav href: 子项 href 落在 /dav 下，且不会自我嵌套", () => {
  const href = davHref("/dav/", "/")
  const child = childHref(href, "strm")
  assert.equal(child, "/dav/strm")

  // 关键：客户端拿 `/dav/strm` 去请求，得到的 href 仍是 `/dav/strm/`
  // （而不是 `/dav/strm/strm/`），循环被打断。
  const next = davHref("/dav/strm", "/strm")
  assert.equal(next, "/dav/strm/")
  const nextChild = childHref(next, "移动")
  assert.equal(nextChild, "/dav/strm/%E7%A7%BB%E5%8A%A8")
  assert.ok(!nextChild.includes("/strm/strm"), "不得出现自我嵌套")
})

test("webdav href: 中文路径编码（父路径与子项名一致编码，不混合）", () => {
  const href = davHref("/dav/%E7%A7%BB%E5%8A%A8/", "/移动/")
  assert.equal(href, "/dav/%E7%A7%BB%E5%8A%A8/")
  // 父段已编码，子段再编码一次 → 两段都是单次编码，不出现裸中文
  const child = childHref(href, "子目录")
  assert.ok(/^\/dav\/%E7%A7%BB%E5%8A%A8\/%[0-9A-Fa-f]{2}/.test(child), `实际: ${child}`)
  assert.ok(!/[\u4e00-\u9fa5]/.test(child), "不得出现未编码的中文")
})

test("webdav href: 已编码段不被二次编码（避免 % 变 %25）", () => {
  assert.equal(encodeDavPath("/%E7%A7%BB%E5%8A%A8/"), "/%E7%A7%BB%E5%8A%A8/")
  assert.equal(davHref("/dav/%E7%A7%BB%E5%8A%A8", "/移动"), "/dav/%E7%A7%BB%E5%8A%A8/")
})

test("webdav href: 挂载点变更时自动适配（不写死 /dav）", () => {
  // 若将来挂到 /webdav，href 应随之为 /webdav/...
  assert.equal(davHref("/webdav/strm", "/strm"), "/webdav/strm/")
  assert.equal(davHref("/webdav/", "/"), "/webdav/")
})

test("webdav href: 多级路径", () => {
  assert.equal(
    davHref("/dav/strm/移动/移动CAS", "/strm/移动/移动CAS"),
    "/dav/strm/%E7%A7%BB%E5%8A%A8/%E7%A7%BB%E5%8A%A8CAS/",
  )
})

test("webdav href: 特殊字符（空格/括号/中文）被正确编码 —— 覆盖真实片名场景", () => {
  // 真实数据里有「天空战记 (1989)」「G 傀灭の刃 全系列【台配+陆配+粤语+日语】」
  const href = davHref("/dav/strm/x/天空战记 (1989)", "/strm/x/天空战记 (1989)")
  assert.ok(href.endsWith("/"), "目录 href 应以 / 结尾")
  assert.ok(!href.includes(" "), "空格必须编码")
  assert.ok(!/[\u4e00-\u9fa5]/.test(href), "中文必须编码")
  // 注：括号 `(` `)` 属 RFC 3986 的 sub-delims，允许出现在路径中，
  //     encodeURIComponent 也会保留它们 —— 这是正确的，不做断言。
})
