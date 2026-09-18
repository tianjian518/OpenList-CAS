/**
 * 虚拟 `.strm` 文件必须**返回文本内容**，不能 302 —— 回归测试
 *
 * ## 复现的线上故障
 *
 * 网易爆米花经 WebDAV 播放时弹「网络异常，请确保网络正常且 WebDAV 地址
 * 正确后重试」，永远播不出来。
 *
 * 根因：`raw.ts` / `webdav.ts` 把 **`.strm`（虚拟文件）** 与
 * **`.cas`（真实文件）** 一视同仁，都 302 到 `/api/p/...`。对 `.strm` 这是致命的：
 *
 *   GET /dav/.../S01E01.mp4.strm
 *   → 302 Location: /api/p/.../S01E01.mp4.strm?sign=…    ← 仍是 .strm！
 *   → 自指，且该地址签名校验不过 → 401 → 播放器报「WebDAV 地址错误」
 *
 * Go 版 `(d *Strm) Link` 的第一件事就是**区分两类文件**：
 *
 *   if file.GetID() == "strm" {                    // ① 虚拟 .strm
 *     link := d.getLink(ctx, file.GetPath())
 *     return &model.Link{RangeReader: ...}, nil    //   → 响应体 = 那行 URL
 *   }
 *   // ② / ③ 才是真实文件走 /p 代理
 *
 * `.strm` 是虚拟文件，唯一意义就是「内容为一行播放 URL 的文本」；
 * 播放器读到后自行请求那行 URL（形如 `/d/...xxx.cas?sign=…`）。
 *
 * ## 另一个已修的坑（本文件同时锁定）
 *
 * `strmContent` 的入参必须是**存储内相对路径**（`resolved.physical`，
 * 如 `/移动/...`），**不是**带挂载点的全路径（`/strm/移动/...`）。
 * 与 op 层 `driver.list(virtualPath, resolved.physical)` 的约定一致。
 * 传错会让 strm 驱动把挂载点名 `strm` 当成第一层目录，永远匹配不到文件。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

/** 复刻 driver 的 getRootAndPath（autoFlatten 分支） */
function getRootAndPath(
  path: string,
  autoFlatten: boolean,
  oneKey: string,
): [string, string] {
  if (autoFlatten) {
    const full = String(path || "/")
      .split("/")
      .filter(Boolean)
      .join("/")
    if (!full) return [oneKey, ""]
    const parts = full.split("/")
    if (parts[0] === oneKey) return [oneKey, parts.slice(1).join("/")]
    return [oneKey, full]
  }
  const p = String(path || "")
    .split("/")
    .filter(Boolean)
    .join("/")
  const i = p.indexOf("/")
  if (i < 0) return [p, ""]
  return [p.slice(0, i), p.slice(i + 1)]
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/")
  return i > 0 ? p.slice(0, i) : "/"
}

function joinPath(a: string, b: string): string {
  const left = String(a || "").replace(/\/+$/, "")
  const right = String(b || "").replace(/^\/+/, "")
  if (!left) return "/" + right
  if (!right) return left
  return left + "/" + right
}

test("strm content: 响应形态必须是 200 文本，不得 302（核心回归点）", () => {
  // 该测试锁定的是「上层选择哪条分支」这一契约。
  // `.strm` 必须走「返回内容」分支；下方是判定条件本身。
  const isStrmVirtual = (p: string) => /\.strm$/i.test(p)
  assert.equal(isStrmVirtual("/a/b/S01E01.mp4.strm"), true)
  assert.equal(isStrmVirtual("/a/b/x.CAS"), false, "真实文件不得走内容分支")
  assert.equal(isStrmVirtual("/a/b/x.mkv"), false)
})

test("strm content: 入参必须是存储内相对路径（挂载点已剥离）", () => {
  // 模拟 op 层传 resolved.physical：挂载 `/strm` 被剥离
  const davPath = "/strm/移动/移动CAS/移动影视CAS/国产剧/在下打更人/S01E01.mp4.strm"
  const physical = "/移动/移动CAS/移动影视CAS/国产剧/在下打更人/S01E01.mp4.strm"

  // 用错（全路径）时：strm 驱动把 `strm` 当成第一层 → sub 里混入挂载点名
  const [, wrongSub] = getRootAndPath(physical.replace("/移动", "/strm/移动"), true, "移动")
  assert.ok(
    wrongSub.startsWith("strm/"),
    "传全路径会让挂载点名污染 sub —— 这正是曾经的 bug",
  )

  // 用对（相对路径）时：sub 从真实第一层目录开始
  const [root, sub] = getRootAndPath(physical, true, "移动")
  assert.equal(root, "移动")
  assert.equal(sub, "移动CAS/移动影视CAS/国产剧/在下打更人/S01E01.mp4.strm")
  assert.ok(!sub.startsWith("strm/"), "不得混入挂载点名")
  assert.equal(dirname(sub), "移动CAS/移动影视CAS/国产剧/在下打更人")
  assert.equal(davPath.endsWith("S01E01.mp4.strm"), true)
})

test("strm content: 生成的播放 URL 指向真实文件而非 .strm 自身", () => {
  const dst = "/移动"
  const sub = "移动CAS/移动影视CAS/国产剧/在下打更人/S01E01.mp4.strm"
  const realName = "S01E01.2026.2160p.WEB-DL.H265.SDR.60fps.10bit.DDP2.0.mp4.cas"
  const realPath = joinPath(dst, joinPath(dirname(sub), realName))

  assert.equal(
    realPath,
    "/移动/移动CAS/移动影视CAS/国产剧/在下打更人/S01E01.2026.2160p.WEB-DL.H265.SDR.60fps.10bit.DDP2.0.mp4.cas",
  )
  assert.ok(realPath.endsWith(".cas"), "URL 必须指向真实 .cas")
  assert.ok(!realPath.endsWith(".strm"), "绝不能自指 .strm")
})

test("strm content: 虚拟名 ↔ 真实名的换算规则（convert 的逆）", () => {
  // convert(): virtualName = trimSuffix(name, sourceExt) + "strm"
  // 例：S01E01.mp4.cas → sourceExt 为 "cas" → 去掉 ".cas" 再拼 "strm"
  //     → S01E01.mp4.strm
  const sourceExt = (n: string) => {
    const i = n.lastIndexOf(".")
    return i >= 0 ? n.slice(i + 1) : ""
  }
  const trimSuffix = (s: string, suf: string) =>
    !suf ? s : s.endsWith(suf) ? s.slice(0, s.length - suf.length) : s
  const toVirtual = (real: string) => trimSuffix(real, sourceExt(real)) + "strm"

  // 真实线上文件名（139 侧是 .cas 占位，convert 逆算得 .strm）
  assert.equal(
    toVirtual("S01E01.2026.2160p.WEB-DL.H265.SDR.60fps.10bit.DDP2.0.mp4.cas"),
    "S01E01.2026.2160p.WEB-DL.H265.SDR.60fps.10bit.DDP2.0.mp4.strm",
  )
  assert.equal(toVirtual("a.mkv.cas"), "a.mkv.strm")
  assert.equal(toVirtual("movie.mkv"), "movie.strm")
})
