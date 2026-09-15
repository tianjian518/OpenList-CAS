/**
 * CAS 模块自测
 *
 * 覆盖：文件名推导、元数据编解码、扩展名白名单、秒传分片计算。
 * 运行：npx tsx --test src/backend/drivers/139/cas/cas.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  deriveRealName,
  decodeCas,
  encodeCas,
  extAllowed,
  isCasName,
  normalizeAllowlist,
  toCasName,
} from "./format"
import { buildPartInfos } from "./restore"
import { shouldHandleCas } from "./player"

/* ------------------------- 文件名 ------------------------- */

test("isCasName 识别 .cas 后缀（大小写不敏感）", () => {
  assert.equal(isCasName("movie.mp4.cas"), true)
  assert.equal(isCasName("movie.MP4.CAS"), true)
  assert.equal(isCasName("movie.mp4"), false)
  assert.equal(isCasName("cas"), false)
})

test("toCasName / deriveRealName 互为逆运算", () => {
  const real = "流浪地球2.2023.2160p.mp4"
  assert.equal(toCasName(real), `${real}.cas`)
  assert.equal(deriveRealName(toCasName(real)), real)
})

test("deriveRealName 在退化命名时回退到元数据 name", () => {
  // 文件名只剩 movie.cas，无内层扩展名
  assert.equal(deriveRealName("movie.cas", "movie.mkv"), "movie.mkv")
  // 元数据也没有扩展名时，保持原样
  assert.equal(deriveRealName("movie.cas", undefined), "movie")
  // 内层有扩展名时以文件名为准，忽略元数据
  assert.equal(deriveRealName("a.mp4.cas", "b.mkv"), "a.mp4")
})

/* ------------------------- 编解码 ------------------------- */

const SAMPLE = {
  name: "测试影片.mkv",
  size: 8_589_934_592,
  md5: "d41d8cd98f00b204e9800998ecf8427e",
  sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  sha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  provider: "139",
}

test("encodeCas → decodeCas 往返一致", () => {
  const encoded = encodeCas(SAMPLE)
  const decoded = decodeCas(encoded)

  assert.equal(decoded.name, SAMPLE.name)
  assert.equal(decoded.size, SAMPLE.size)
  assert.equal(decoded.md5, SAMPLE.md5)
  assert.equal(decoded.sha1, SAMPLE.sha1)
  assert.equal(decoded.sha256, SAMPLE.sha256)
  assert.equal(decoded.provider, SAMPLE.provider)
})

test("encodeCas 产物是合法 base64 且可解析为 JSON", () => {
  const encoded = encodeCas(SAMPLE)
  // 注意：atob 得到的是 latin1 字符串，含中文时需再按 UTF-8 解一遍
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
  const json = JSON.parse(new TextDecoder().decode(bytes))
  assert.equal(json.name, SAMPLE.name)
  assert.equal(json.size, SAMPLE.size)
  // 落盘字段名用 preID，与既有工具链保持一致
  assert.ok("create_time" in json)
})

test("decodeCas 兼容缺失 padding 的 base64", () => {
  const encoded = encodeCas(SAMPLE)
  const stripped = encoded.replace(/=+$/, "")
  const decoded = decodeCas(stripped)
  assert.equal(decoded.name, SAMPLE.name)
})

test("decodeCas 兼容首尾空白与 Uint8Array 输入", () => {
  const encoded = encodeCas(SAMPLE)
  assert.equal(decodeCas(`\n  ${encoded}  \n`).name, SAMPLE.name)

  const bytes = new TextEncoder().encode(encoded)
  assert.equal(decodeCas(bytes).name, SAMPLE.name)
  assert.equal(decodeCas(bytes.buffer).name, SAMPLE.name)
})

test("decodeCas 拒绝空内容 / 非 base64 / 非 JSON", () => {
  assert.throws(() => decodeCas(""), /为空/)
  assert.throws(() => decodeCas("   "), /为空/)
  assert.throws(() => decodeCas("这不是base64!!!"), /base64|JSON/)
})

test("decodeCas 校验必需字段", () => {
  const noName = btoa(JSON.stringify({ size: 1, md5: "x" }))
  assert.throws(() => decodeCas(noName), /name/)

  const badSize = btoa(JSON.stringify({ name: "a.mp4", size: -1, md5: "x" }))
  assert.throws(() => decodeCas(badSize), /size/)

  const noHash = btoa(JSON.stringify({ name: "a.mp4", size: 1 }))
  assert.throws(() => decodeCas(noHash), /哈希/)
})

test("encodeCas 缺少 name 时抛错", () => {
  assert.throws(() => encodeCas({ name: "", size: 1 }), /name/)
})

test("decodeCas 将 preID 映射为 preId", () => {
  const raw = btoa(
    JSON.stringify({ name: "a.mp4", size: 1, md5: "m", preID: "P-123" }),
  )
  assert.equal(decodeCas(raw).preId, "P-123")
})

test("sliceMd5 缺失时回落为 md5", () => {
  const raw = btoa(JSON.stringify({ name: "a.mp4", size: 1, md5: "MMM" }))
  assert.equal(decodeCas(raw).sliceMd5, "MMM")
})

/* ------------------------- 白名单 ------------------------- */

test("normalizeAllowlist 清洗分隔符、点号与大小写", () => {
  assert.equal(normalizeAllowlist(".MP4, .MKV ;ts"), "mp4,mkv,ts")
  assert.equal(normalizeAllowlist("mp4 mp4 mkv"), "mp4,mkv")
  assert.equal(normalizeAllowlist(""), "")
})

test("normalizeAllowlist 遇 * 返回通配", () => {
  assert.equal(normalizeAllowlist("mp4,*"), "*")
  assert.equal(normalizeAllowlist("*"), "*")
})

test("extAllowed 空白名单表示全部放行", () => {
  assert.equal(extAllowed("a.anything", ""), true)
  assert.equal(extAllowed("a", ""), true)
})

test("extAllowed 命中也大小写不敏感", () => {
  assert.equal(extAllowed("a.MP4", "mp4,mkv"), true)
  assert.equal(extAllowed("a.mkv", "mp4,mkv"), true)
  assert.equal(extAllowed("a.avi", "mp4,mkv"), false)
  assert.equal(extAllowed("noext", "mp4"), false)
})

test("extAllowed 通配放行全部", () => {
  assert.equal(extAllowed("a.xyz", "*"), true)
})

/* --------------------- shouldHandleCas --------------------- */

test("shouldHandleCas 只接管 .cas 且内层是视频", () => {
  assert.equal(shouldHandleCas("movie.mp4.cas"), true)
  assert.equal(shouldHandleCas("movie.mkv.cas"), true)
  assert.equal(shouldHandleCas("movie.TS.cas"), true)
  // 内层不是视频 → 不接管，交给普通下载
  assert.equal(shouldHandleCas("doc.pdf.cas"), false)
  // 非 .cas → 不接管
  assert.equal(shouldHandleCas("movie.mp4"), false)
})

test("shouldHandleCas 尊重自定义白名单", () => {
  assert.equal(shouldHandleCas("book.epub.cas", "epub"), true)
  assert.equal(shouldHandleCas("movie.mp4.cas", "epub"), false)
  // 通配时全部接管
  assert.equal(shouldHandleCas("anything.bin.cas", "*"), true)
})

/* --------------------- 秒传分片计算 --------------------- */

test("buildPartInfos 小文件单分片", () => {
  const parts = buildPartInfos(1024)
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0], { partNumber: 1, partSize: 1024 })
})

test("buildPartInfos 十分片边界", () => {
  const ten = 10 * 1024 * 1024
  assert.equal(buildPartInfos(ten).length, 1)
  assert.equal(buildPartInfos(ten + 1).length, 2)
})

test("buildPartInfos 分片号递增且总和不超 size", () => {
  const size = 25 * 1024 * 1024 + 777
  const parts = buildPartInfos(size)
  assert.equal(parts.length, 3)
  parts.forEach((p, i) => assert.equal(p.partNumber, i + 1))
  const total = parts.reduce((s, p) => s + p.partSize, 0)
  assert.equal(total, size)
})

test("buildPartInfos 空文件也返回一个分片", () => {
  const parts = buildPartInfos(0)
  assert.equal(parts.length, 1)
  assert.equal(parts[0].partSize, 0)
})

test("buildPartInfos 分片数封顶 100", () => {
  // 100 片 × 10MB = 1000MB，超出的部分不再声明
  const parts = buildPartInfos(2000 * 1024 * 1024)
  assert.equal(parts.length, 100)
})
