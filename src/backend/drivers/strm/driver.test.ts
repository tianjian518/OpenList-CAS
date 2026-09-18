/**
 * Strm 驱动 getRootAndPath 回归测试
 *
 * ## 为什么必须有这个文件
 *
 * 线上曾出现「STRM 挂载点下平白多出一层同名目录」：
 * 用户在网页点 `移动CAS`，列出来却还是根目录内容（里面又有 `移动CAS`），
 * 再点一次才进到正确层级 —— 肉眼看着就是"两层一样的目录"。
 *
 * 根因是 autoFlatten 分支里 `full` 不含斜杠时直接返回空 sub，
 * 把整段目录名丢掉了，导致 Join(dst, "") 退回根目录。
 *
 * 该 bug 不会报错、不会 500，只是"静默列错一层"，极易在重构中被改回来，
 * 因此这里把每一层的期望映射都钉死。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { getRootAndPath } from "./driver"

/**
 * 单条 paths 时的真实场景：
 *   paths = "/移动"  →  getPair 产出 key="移动"、value="/移动"
 *   pathMap = { "移动": ["/移动"] }  →  size===1 → autoFlatten=true, oneKey="移动"
 */
const KEY = "移动"
const DST = "/移动"

/** 复刻 driver 内部 list() 的 joinPath(dst, sub) 语义 */
function joinPath(base: string, sub: string): string {
  const a = String(base || "").replace(/\/+$/, "")
  const b = String(sub || "").replace(/^\/+/, "")
  if (!b) return a || "/"
  return `${a}/${b}`
}

/** 得到「这个请求最终会去读 139 的哪个真实路径」 */
function resolved(path: string): string {
  const [root, sub] = getRootAndPath(path, true, KEY)
  assert.equal(root, KEY, `root 应恒为唯一的映射 key（${KEY}）`)
  return joinPath(DST, sub)
}

test("Strm/getRootAndPath: 根目录 → 映射源头（由 list() 的 listRoot 分支接管）", () => {
  const [root, sub] = getRootAndPath("/", true, KEY)
  assert.equal(root, KEY)
  assert.equal(sub, "")
})

test("Strm/getRootAndPath: 一层目录必须保留，不能丢成根目录（历史 BUG）", () => {
  // 回归点：修复前这里返回 sub=""，于是列出来的是 /移动 根目录，
  // 用户看到的就是"点进去还是那一堆目录"。
  assert.equal(resolved("/移动CAS"), "/移动/移动CAS")
  assert.equal(resolved("移动CAS"), "/移动/移动CAS", "无前导斜杠也要正确")
})

test("Strm/getRootAndPath: 两层目录不能被剥掉第一层", () => {
  assert.equal(resolved("/移动CAS/移动影视CAS"), "/移动/移动CAS/移动影视CAS")
  assert.equal(resolved("/移动CAS/cas600t"), "/移动/移动CAS/cas600t")
})

test("Strm/getRootAndPath: 以 oneKey 开头时剥掉该段（用户点映射名的正常路径）", () => {
  // 展平后列表里显示的是 key 本身（「移动」），点进去的请求会带这一段。
  assert.equal(resolved("/移动"), "/移动")
  assert.equal(resolved("/移动/移动CAS"), "/移动/移动CAS")
  assert.equal(resolved("/移动/移动CAS/移动影视CAS"), "/移动/移动CAS/移动影视CAS")
})

test("Strm/getRootAndPath: 重复斜杠与前导斜杠被规范化", () => {
  assert.equal(resolved("//移动CAS//移动影视CAS"), "/移动/移动CAS/移动影视CAS")
  assert.equal(resolved("/移动CAS/"), "/移动/移动CAS")
})

test("Strm/getRootAndPath: 多路径（非展平）时按第一段取 root", () => {
  // paths 有多条时 autoFlatten=false，root 由请求首段决定。
  const [root, sub] = getRootAndPath("/电影/欧美电影", false, "")
  assert.equal(root, "电影")
  assert.equal(sub, "欧美电影")

  const [root2, sub2] = getRootAndPath("/电影", false, "")
  assert.equal(root2, "电影")
  assert.equal(sub2, "")
})
