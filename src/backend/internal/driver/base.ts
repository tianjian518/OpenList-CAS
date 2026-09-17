export interface FileItem {
  name: string
  size: number
  is_dir: boolean
  created?: string
  modified: string
  sign: string
  type: number // 1: FOLDER, 2: VIDEO, 3: AUDIO, 4: TEXT, 5: IMAGE, 0: UNKNOWN
  thumb?: string
  raw_url?: string
  /** Headers that must accompany the raw_url request (e.g. Cookie, Referer for cloud drives) */
  raw_url_headers?: Record<string, string>
  /** When the driver could not obtain a download link, the concrete reason (for better 404 reporting) */
  raw_url_error?: string
  /**
   * 该条目对应的**虚拟路径**（挂载点之后的完整路径，含挂载点）。
   *
   * 对齐 Go `model.Object.GetPath()`：strm 驱动在 `Link` 的分支 ③ 里需要用
   * **虚拟路径**（而非底层真实路径）去拼 `/p{EncodePath(path)}?sign={sign(path)}`。
   * 驱动若填了本字段，raw 路由会优先用它；否则退化为请求路径。
   */
  path?: string
  /**
   * `.cas` 占位文件的**预览名**（原始视频名，如 `第10集.mkv`）。
   *
   * 对齐 Go `server/handles/fsread.go:resolveCASPreviewTypeName` +
   * `driver.CASPreviewNamer`：139 驱动通过 `CASPreviewName(ctx, obj)`
   * 读出 `.cas` 内容里记录的真实文件名，FsGet 用它（而非 `.cas` 文件名）
   * 计算响应的 `type` 字段：
   *
   *   typeName = resolveCASPreviewTypeName(ctx, storage, obj)   // → "第10集.mkv"
   *   ...
   *   Type: utils.GetFileType(typeName),                        // → VIDEO(2)
   *
   * 即：`/api/fs/get` 对 `.cas` 返回的 `name` 仍是 `第10集.mkv.cas`、
   * `size` 仍是 540（占位大小），但 `type` 必须是真实视频的类型，
   * 否则前端/播放器不认为它是可播放的视频。
   */
  cas_preview_name?: string
  /** Whole-file hash (e.g. md5) used for rapid upload */
  hash?: string
  /**
   * Whole-file hashes by algorithm, populated by drivers whose file listings
   * expose hashes (e.g. md5, sha1, sha256). Prefer this over the legacy `hash`
   * field; seed capability preflight consumes these to avoid re-downloading.
   */
  hashes?: {
    md5?: string
    sha1?: string
    sha256?: string
  }
}

/**
 * 计算 OpenList 前端使用的文件类型常量。
 *
 * **严格对齐 Go `pkg/utils/file.go` 的 `GetFileType`**：
 *
 *   func GetFileType(filename string) int {
 *     ext := strings.ToLower(Ext(filename))
 *     if SliceContains(conf.SlicesMap[conf.AudioTypes], ext) { return conf.AUDIO }
 *     if SliceContains(conf.SlicesMap[conf.VideoTypes], ext) { return conf.VIDEO }
 *     if SliceContains(conf.SlicesMap[conf.ImageTypes], ext) { return conf.IMAGE }
 *     if SliceContains(conf.SlicesMap[conf.TextTypes], ext)  { return conf.TEXT }
 *     return conf.UNKNOWN
 *   }
 *
 * 顺序很关键（**AUDIO → VIDEO → IMAGE → TEXT**），且四个列表取自
 * Go `internal/bootstrap/data/setting.go` 的默认值：
 *
 *   audio_types: mp3,flac,ogg,m4a,wav,opus,wma
 *   video_types: mp4,mkv,avi,mov,rmvb,webm,flv,m3u8
 *   image_types: jpg,tiff,jpeg,png,gif,bmp,svg,ico,swf,webp,avif
 *   text_types : txt,htm,html,xml,java,properties,sql,js,md,json,conf,ini,
 *                vue,php,py,bat,gitignore,yml,go,sh,c,cpp,h,hpp,tsx,vtt,
 *                srt,ass,rs,lrc,**strm**
 *
 * ⚠️ 这里此前用的是自造的大杂烩列表，与 Go 有实质差异：
 *   - 缺少 `strm` → `.strm` 得到 UNKNOWN(0) 而非 TEXT(4)；
 *   - 多出 `ts`/`m2ts`/`wmv`/`3gp`/`asf` 等未在 Go 列表中的扩展名。
 * 前端与播放器依赖 `type` 判定「是否可预览 / 用哪种预览器」，
 * 不一致会直接导致播放行为不同（网易爆米花即依赖此字段）。
 *
 * 常量值（Go `internal/conf/const.go`）：
 *   UNKNOWN=0, FOLDER=1, VIDEO=2, AUDIO=3, TEXT=4, IMAGE=5
 */
export function calcFileType(name: string, isDir: boolean): number {
  if (isDir) return 1 // FOLDER
  const ext = (name.split(".").pop() || "").toLowerCase()
  // 与 Go 一致：无扩展名（split 后等于原名且不含点）视为 UNKNOWN
  if (!name.includes(".")) return 0 // UNKNOWN

  // ── AUDIO (3) ── 注意 Go 先判音频
  if (
    ["mp3", "flac", "ogg", "m4a", "wav", "opus", "wma"].includes(ext)
  )
    return 3 // AUDIO

  // ── VIDEO (2) ──
  if (
    ["mp4", "mkv", "avi", "mov", "rmvb", "webm", "flv", "m3u8"].includes(ext)
  )
    return 2 // VIDEO

  // ── IMAGE (5) ──
  if (
    [
      "jpg",
      "tiff",
      "jpeg",
      "png",
      "gif",
      "bmp",
      "svg",
      "ico",
      "swf",
      "webp",
      "avif",
    ].includes(ext)
  )
    return 5 // IMAGE

  // ── TEXT (4) ──
  if (
    [
      "txt",
      "htm",
      "html",
      "xml",
      "java",
      "properties",
      "sql",
      "js",
      "md",
      "json",
      "conf",
      "ini",
      "vue",
      "php",
      "py",
      "bat",
      "gitignore",
      "yml",
      "go",
      "sh",
      "c",
      "cpp",
      "h",
      "hpp",
      "tsx",
      "vtt",
      "srt",
      "ass",
      "rs",
      "lrc",
      "strm",
    ].includes(ext)
  )
    return 4 // TEXT

  return 0 // UNKNOWN
}

export interface StorageDriver {
  init?(): Promise<void>
  list(virtualPath: string, physicalPath: string): Promise<FileItem[]>
  get(virtualPath: string, physicalPath: string): Promise<FileItem>
  mkdir(virtualPath: string, physicalPath: string): Promise<void>
  rename(
    virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void>
  remove(
    virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void>
  move(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void>
  copy(
    srcDir: string,
    dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void>
  put(virtualPath: string, physicalPath: string, content: Buffer): Promise<void>
}
