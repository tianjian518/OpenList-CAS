// 路径编码：与 Go 标准库 `net/url.PathEscape` 逐字符对齐。
//
// 为什么不用 `encodeURIComponent`：
//   JS 与 Go 对「子分隔符」的处理不同，导致同一条路径在两边生成**不同的 URL**。
//
//   Go `url.PathEscape` 只转义真正会破坏路径结构的字符
//   （`?` `#` `/` `%` 以及空白、控制字符、非 ASCII），
//   以下字符**原样保留**：
//       $ & + , : ; = @
//       - . _ ~
//       0-9 A-Z a-z
//   还会把空格转成 `+`（`url.PathEscape` 的 encodePath 用 shouldEscape，
//   空格在 path 段中属于 sub-delims 之外 → 转义为 `%20`；见下方说明）。
//
//   `encodeURIComponent` 则会额外转义 `$ & + , / : ; = ? @` 中的大多数，
//   例如 `师兄啊师兄（2023）` 中不含这些字符时看起来一致，
//   但文件名里带 `+`（如 `S01+E01`）或 `:`（如 `E01:02`）时就会跑偏。
//
// 参考 Go 源码（net/url/url.go）：
//
//	func PathEscape(s string) string { return escape(s, encodePathSegment) }
//	// encodePathSegment 下 escape 表：
//	//   '$', '&', '+', ',', '/', ':', ';', '=', '?', '@'
//	//   这些在 encodePathSegment 中 **不** 转义。
//	// 实际实现中 shouldEscape 对 encodePathSegment 返回：
//	//   '$' '&' '+' ',' ':' ';' '=' '@' → false（不转义）
//	//   '/' → false（PathEscape 按段调用，段内本就不含 '/'）
//	//   '-' '_' '.' '~' 以及字母数字 → false
//	//   其余（含 ' ' '%' '#' '?' 等）→ true（转义）
export function goPathEscapeSegment(seg: string): string {
  let out = ""
  for (const ch of seg) {
    const code = ch.codePointAt(0)!
    if (goPathEscapeShouldSkip(code)) {
      out += ch
    } else {
      out += percentEncode(ch)
    }
  }
  return out
}

/**
 * Go `url.PathEscape` 中 shouldEscape(c, encodePathSegment) == false 的字符集。
 * 返回 true 表示「原样输出，不转义」。
 */
function goPathEscapeShouldSkip(code: number): boolean {
  // 未保留字符 unreserved：A-Z a-z 0-9 - _ . ~
  if (code >= 0x41 && code <= 0x5a) return true // A-Z
  if (code >= 0x61 && code <= 0x7a) return true // a-z
  if (code >= 0x30 && code <= 0x39) return true // 0-9
  if (code === 0x2d) return true // -
  if (code === 0x5f) return true // _
  if (code === 0x2e) return true // .
  if (code === 0x7e) return true // ~

  // 子分隔符 sub-delims 中 Go 在 path 段里保留的部分
  if (code === 0x24) return true // $
  if (code === 0x26) return true // &
  if (code === 0x2b) return true // +
  if (code === 0x2c) return true // ,
  if (code === 0x3a) return true // :
  if (code === 0x3b) return true // ;
  if (code === 0x3d) return true // =
  if (code === 0x40) return true // @

  // 其它一律转义
  return false
}

/** 对单个 Unicode 码点做百分号编码（UTF-8，大写十六进制，与 Go 一致）。 */
function percentEncode(ch: string): string {
  const bytes =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(ch)
      : Uint8Array.from(unescape(encodeURIComponent(ch)), (c) =>
          c.charCodeAt(0),
        )
  let out = ""
  for (const b of bytes) {
    out += "%" + b.toString(16).toUpperCase().padStart(2, "0")
  }
  return out
}

/**
 * 与 Go `utils.EncodePath(path, true)` 等价：按 `/` 切段，逐段 PathEscape。
 *
 *   func EncodePath(path string, all ...bool) string {
 *     seg := strings.Split(path, "/")
 *     for i := range seg {
 *       if len(all) > 0 && all[0] { seg[i] = url.PathEscape(seg[i]) }
 *       else { /* 逐字符替换 % ? # *\/ }
 *     }
 *     return strings.Join(seg, "/")
 *   }
 */
export function goEncodePath(path: string): string {
  return String(path)
    .split("/")
    .map((seg) => goPathEscapeSegment(seg))
    .join("/")
}
