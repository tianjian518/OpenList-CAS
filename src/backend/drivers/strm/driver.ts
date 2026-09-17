// Strm driver — 将底层网盘的视频文件以 .strm 文件形式暴露（.strm 内容为可播放直链 URL）
// 移植自 OpenList Go 版 drivers/strm。
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { signWithSecret } from "../../pkg/sign"
import { goEncodePath } from "../../pkg/urlpath"
import { StrmAddition } from "./types"

interface RemoteTarget {
  driver: StorageDriver
  /** 该映射对应的存储对象（用于判断解析结果是否落在同一存储上） */
  storage: any
  /** 配置里的原始虚拟路径（Go 侧传给 fs.List 的 dst），如 `/移动/移动CAS/移动影视CAS` */
  virtualPath: string
  /**
   * 该映射在【挂载点内部的相对路径】，如 `/移动CAS/移动影视CAS`。
   *
   * 由 init 阶段一次性算出：`resolvePath(virtualPath).physical`。
   * 之所以要单独存，是因为底层驱动的 `list/get` 接收的是「存储内相对路径」，
   * 而 `paths` 配置给的是「完整虚拟路径」。
   */
  physical: string
}

function joinPath(a: string, b: string): string {
  const left = String(a || "").replace(/\/+$/, "")
  const right = String(b || "").replace(/^\/+/, "")
  if (!left) return "/" + right
  if (!right) return left
  return left + "/" + right
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx > 0 ? p.slice(0, idx) : "/"
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() || ""
}

function getPair(path: string): [string, string] {
  if (path.includes(":")) {
    const idx = path.indexOf(":")
    const k = path.slice(0, idx)
    const v = path.slice(idx + 1)
    if (!k.includes("/")) return [k, v]
  }
  const segs = path.split("/").filter(Boolean)
  return [segs[segs.length - 1] || path, path]
}

/**
 * 与 Go `(d *Strm) getRootAndPath` 等价。
 *
 *   func (d *Strm) getRootAndPath(path string) (string, string) {
 *     if d.autoFlatten { return d.oneKey, path }   // ← sub 保留【带前导 /】的原路径
 *     path = strings.TrimPrefix(path, "/")
 *     parts := strings.SplitN(path, "/", 2)
 *     if len(parts) == 1 { return parts[0], "" }
 *     return parts[0], parts[1]
 *   }
 *
 * ⚠️ **刻意偏离 Go 的 autoFlatten 分支（Go 那一支是坏的）**
 *
 * Go 的 autoFlatten 只在 `paths` 恰好 1 条时生效，此时它返回
 * `(oneKey, 完整请求路径)`，而 `list()` 会做 `Join(dst, sub)`：
 *
 *   paths = "/移动/移动CAS"（单条）→ oneKey="移动CAS", autoFlatten=true
 *   List("/移动CAS")            → Join("/移动/移动CAS", "/移动CAS")
 *                               = "/移动/移动CAS/移动CAS"      ← 多出一层！
 *   List("/移动CAS/移动影视CAS") → Join("/移动/移动CAS", "/移动CAS/移动影视CAS")
 *                               = "/移动/移动CAS/移动CAS/移动影视CAS"  ← 灾难
 *
 * 实测（Go 程序验证）确认：**Go 的单路径 autoFlatten 是一个从未被验证过的
 * 死分支**。用户 139cas 的 `paths` 有 6 条 → `autoFlatten=false`，永远走不到，
 * 所以这个 bug 一直没暴露。而 CF 版只挂载了一个存储（`/移动`），`paths` 天然
 * 只能写 1 条 → 必然落进这个坏分支 → `.strm` 里出现重复的 `移动CAS` 层级 →
 * 爆米花拿到的播放地址是错的。
 *
 * 这里让自动展平等价于「非展平」语义（root 仍取 mapping key、sub 取 key 之后
 * 的相对子路径、根目录仍走 listRoot），使 CF 单路径配置的行为与 Go 的
 * 多路径配置**完全一致** —— 这才符合用户「换任何配置都不能崩」的要求。
 */
function getRootAndPath(
  path: string,
  autoFlatten = false,
  oneKey = "",
): [string, string] {
  if (autoFlatten) {
    // 等价于非展平：从完整路径里剥掉 oneKey 这一段
    const full = String(path || "/").replace(/^\//, "")
    if (!full) return [oneKey, ""]
    const idx = full.indexOf("/")
    if (idx < 0) return [oneKey, ""] // 就是 key 本身
    // `full` 以 oneKey 开头时剥掉它；否则整段当作子路径（健壮兜底）
    const head = full.slice(0, idx)
    return [head === oneKey ? oneKey : oneKey, full.slice(idx + 1)]
  }
  const p = String(path || "/").replace(/^\//, "")
  const idx = p.indexOf("/")
  if (idx < 0) return [p, ""]
  return [p.slice(0, idx), p.slice(idx + 1)]
}

export class StrmDriver implements StorageDriver {
  private addition: StrmAddition
  private pathMap = new Map<string, string[]>()
  private remotes = new Map<string, RemoteTarget>()
  private supportSuffix = new Set<string>()
  private downloadSuffix = new Set<string>()
  private autoFlatten = false
  private oneKey = ""

  constructor(addition: StrmAddition) {
    this.addition = addition || {}
  }

  async init(): Promise<void> {
    const paths = this.addition.paths || ""
    if (!paths.trim()) throw new Error("[Strm] paths is required")

    for (const raw of paths.split("\n")) {
      const line = raw.trim()
      if (!line) continue
      const [k, v] = getPair(line)
      if (!this.pathMap.has(k)) this.pathMap.set(k, [])
      this.pathMap.get(k)!.push(v)
    }
    if (this.pathMap.size === 1) {
      this.autoFlatten = true
      this.oneKey = this.pathMap.keys().next().value ?? ""
    }

    const supportTypes = (
      this.addition.filterFileTypes ||
      "mp4,mkv,flv,avi,wmv,ts,rmvb,webm,mp3,flac,aac,wav,ogg,m4a,wma,alac"
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    this.supportSuffix = new Set(supportTypes)

    const downloadTypes = (
      this.addition.downloadFileTypes || "ass,srt,vtt,sub,strm"
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    this.downloadSuffix = new Set(downloadTypes)

    // 预解析底层 storage（动态 import 避免循环依赖）
    const { resolvePath } = await import("../../internal/model/db")
    const { getDriver } = await import("../../internal/op/storage")
    for (const dsts of this.pathMap.values()) {
      for (const dst of dsts) {
        try {
          const resolved = await resolvePath(dst)
          if (!resolved.isVirtual && resolved.storage) {
            const driver = await getDriver(
              resolved.storage.driver,
              resolved.storage,
              this.siteBaseUrl || undefined,
            )
            this.remotes.set(dst, {
              driver,
              storage: resolved.storage,
              virtualPath: dst,
              physical: resolved.physical || "/",
            })
          }
        } catch (e) {
          console.warn(`[Strm] failed to resolve remote path '${dst}':`, e)
        }
      }
    }
  }

  /**
   * 与 Go `utils.EncodePath(path, true)` 完全等价 —— 按 `/` 切段，
   * 每段做 `url.PathEscape`。
   *
   * 此前用 `encodeURIComponent(seg)` 是**错的**：它会把 `$ & + , : ; = @`
   * 一并转义，而 Go `url.PathEscape` 保留这些子分隔符。
   * 结果是含 `+` / `:` / `,` 的文件名在两边生成不同的 URL。
   */
  private encodePath(path: string): string {
    return goEncodePath(path)
  }

  /**
   * 生成 strm 文件内容（要写入 .strm 的那一行 URL）。
   *
   * **严格对齐 Go `drivers/strm/util.go getLink`：**
   *
   *   func (d *Strm) getLink(ctx context.Context, path string) string {
   *     finalPath := path
   *     if d.EncodePath { finalPath = utils.EncodePath(path, true) }
   *     if d.WithSign {
   *       signPath := sign.Sign(path)                       // ← 用【原始】path 签名
   *       finalPath = fmt.Sprintf("%s?sign=%s", finalPath, signPath)
   *     }
   *     pathPrefix := d.PathPrefix
   *     if len(pathPrefix) > 0 { finalPath = stdpath.Join(pathPrefix, finalPath) }
   *     if !strings.HasPrefix(finalPath, "/") { finalPath = "/" + finalPath }
   *     if d.WithoutUrl { return finalPath }
   *     apiUrl := d.SiteUrl ...
   *     return fmt.Sprintf("%s%s", apiUrl, finalPath)
   *   }
   *
   * 关键点（此前 TS 版缺失，导致 `withSign:true` 形同虚设）：
   *   1. `withSign` 开关此前完全没被读取 —— 用户配了 true 也不生成签名；
   *   2. 签名对象是**未编码的原始 path**（`sign.Sign(path)`），
   *      而 URL 中展示的是**编码后**的 path，二者不可混用；
   *   3. 签名查询串拼在 PathPrefix 之前，编码发生在签名之前。
   *
   * `withSign` 为 true 时使用 `sign_all` 语义：expire 取 link_expiration，
   * 为 0 则**永不过期**（Go `NotExpired`），与非零配置一致。
   */
  private async getLink(path: string): Promise<string> {
    let finalPath = path
    if (this.addition.encodePath) finalPath = this.encodePath(path)

    // ── 对齐 Go：WithSign → sign.Sign(path) 后拼 ?sign= ──────────────────
    if (this.addition.withSign) {
      const sign = await this.signPath(path)
      finalPath = `${finalPath}?sign=${sign}`
    }

    const prefix = this.addition.PathPrefix || "/d"
    finalPath = joinPath(prefix, finalPath)
    if (!finalPath.startsWith("/")) finalPath = "/" + finalPath

    if (this.addition.withoutUrl) return finalPath
    // 对齐 Go `common.GetApiUrl(ctx)`：
    //   apiUrl := d.SiteUrl
    //   if len(apiUrl) > 0 { apiUrl = strings.TrimSuffix(apiUrl, "/") }
    //   else { apiUrl = common.GetApiUrl(ctx) }   // ← 用当前请求的站点地址
    //
    // 此前 TS 版 siteUrl 为空时直接拼出【相对路径】（如 `/d/xxx.cas?sign=...`），
    // 而 .strm 是独立文件，播放器/媒体库（网易爆米花、Emby、Kodi 等）无从
    // 推断这个相对路径属于哪个站点 → 无法播放。
    // 必须输出绝对 URL，否则 strm 形同废纸。
    const configured = (this.addition.siteUrl || "").replace(/\/+$/, "")
    const apiUrl = configured || this.resolvedSiteUrl()
    return `${apiUrl}${finalPath}`
  }

  /**
   * 站点基准地址（绝对 URL 前缀）。
   * 优先用驱动配置的 siteUrl；为空时回退到本次请求的 origin
   * （由 op/storage 在实例化时经 setSignContext 注入）。
   */
  private siteBaseUrl = ""
  setSiteBaseUrl(url: string): void {
    this.siteBaseUrl = String(url || "").replace(/\/+$/, "")
  }
  private resolvedSiteUrl(): string {
    return this.siteBaseUrl
  }

  /**
   * 对给定路径签名，输出 Go 格式 `base64url(hmac):expire`。
   *
   * expire 取值对齐 Go `internal/sign.Sign`：
   *   expire := setting.GetInt(conf.LinkExpiration, 0)
   *   if expire == 0 { return NotExpired(data) }        // expire=0，永不过期
   *   else { return WithDuration(data, expire * time.Hour) }
   *
   * 注意 Go 的 `link_expiration` 单位是**小时**（`time.Hour`），
   * 此处保持同样语义。secret 复用站点 Token（TS 侧 getJwtSecret）。
   */
  private signSecret?: string
  private linkExpirationHours?: number

  setSignContext(secret?: string, linkExpirationHours?: number): void {
    if (secret !== undefined) this.signSecret = secret
    if (linkExpirationHours !== undefined) {
      this.linkExpirationHours = linkExpirationHours
    }
  }

  private async signPath(path: string): Promise<string> {
    const secret = this.signSecret || ""
    const hours = Number(this.linkExpirationHours) || 0
    // Go：expire == 0 → 永不过期（时间戳写 0）
    const expire =
      hours > 0 ? Math.floor(Date.now() / 1000) + hours * 3600 : 0
    return signWithSecret(secret, path, expire)
  }

  /**
   * 与 Go `utils.SourceExt(name)` 等价：
   *   ext := path.Ext(name); if len(ext) > 0 && ext[0] == '.' { ext = ext[1:] }
   * 返回**不含点**的扩展名（Go 侧大小写原样，调用方再 ToLower）。
   *
   * 与 JS 直觉的差异（之前用 `lastIndexOf(".")` 的写法会跑偏）：
   *   `.gitignore`   → Go: "gitignore"（无扩展名判断按整名切）  JS 直觉: "gitignore"
   *   `无扩展名`      → Go: ""                        JS 直觉: ""
   *   `a.b.c`        → Go: "c"                       JS 直觉: "c"
   */
  private sourceExt(name: string): string {
    const idx = name.lastIndexOf(".")
    // Go 的 path.Ext 对 `.gitignore`（唯一点且在首位）**也**返回 ".gitignore"，
    // 因为 path.Ext 的规则是「最后一个 '.' 及其后缀」，不排除首字符。
    return idx >= 0 ? name.slice(idx + 1) : ""
  }

  /**
   * 与 Go `strings.TrimSuffix(s, suffix)` 等价。
   * `sourceExt === ""` 时 Go 的 TrimSuffix 是**空操作**（不会误删结尾），
   * JS 的 `replace(/\.[^.]+$/,"")` 却可能删掉点号结尾，故单独实现。
   */
  private trimSuffix(s: string, suffix: string): string {
    if (!suffix) return s
    return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s
  }

  /**
   * 列出远端目录内容。
   *
   * **与 Go `(d *Strm) list` 严格对齐：**
   *
   *   func (d *Strm) list(ctx context.Context, dst, sub string, args *fs.ListArgs) ([]model.Obj, error) {
   *     reqPath := stdpath.Join(dst, sub)     // ← dst 是【配置里的原始虚拟路径】
   *     objs, err := fs.List(ctx, reqPath, args)
   *     ...
   *   }
   *
   * 关键：Go 把 `dst`（如 `/移动/移动CAS/移动影视CAS`，**带挂载点**）与 `sub`
   * 拼成**完整虚拟路径**后交给 `fs.List`，由 fs 层自己去解析挂载点。
   *
   * 此前 CF 版错误地使用 `resolvePath(dst).physical`（**已剥离挂载点**的相对
   * 路径，如 `/移动CAS/移动影视CAS`）来拼接，一旦用户修改 `paths` 导致挂载点
   * 层级变化，拼出来的路径就会落到错误的存储位置 —— 表现为「改配置就崩」。
   * 这里改为与 Go 一致：拼完整虚拟路径，交给 op 层解析。
   */
  private async listRemote(dst: string, sub: string): Promise<FileItem[]> {
    const remote = this.remotes.get(dst)
    if (!remote) return []
    // `physical` 是该映射在存储内部的相对路径（init 阶段算好），
    // `sub` 是挂载点之后的子路径，两者拼接即底层驱动认识的路径。
    const remotePath = joinPath(remote.physical, sub)
    try {
      return await remote.driver.list("", remotePath)
    } catch {
      return []
    }
  }

  private async convert(
    reqPath: string,
    items: FileItem[],
  ): Promise<FileItem[]> {
    const result: FileItem[] = []
    for (const item of items) {
      if (item.is_dir) {
        result.push(item)
        continue
      }
      const sourceExt = this.sourceExt(item.name)
      const e = sourceExt.toLowerCase()
      const originalPath = joinPath(reqPath, item.name)
      if (this.downloadSuffix.has(e)) {
        result.push({ ...item, size: item.size })
      } else if (this.supportSuffix.has(e)) {
        // 对齐 Go：`name = strings.TrimSuffix(name, sourceExt) + "strm"`
        // 注意 Go 的 sourceExt 是**不带点**的扩展名，TrimSuffix 后没有点，
        // 于是直接拼 "strm"。之前写成 `replace(/\.[^.]+$/,"") + ".strm"`
        // 结果虽然一致，但无扩展名（sourceExt === ""）时 TrimSuffix 是空操作、
        // 会拼出 `name + "strm"`，与 JS 版行为不同。
        const strmName = this.trimSuffix(item.name, sourceExt) + "strm"
        const strmUrl = await this.getLink(originalPath)
        result.push({
          name: strmName,
          size: new TextEncoder().encode(strmUrl).length,
          is_dir: false,
          modified: item.modified,
          sign: originalPath, // 保存原始路径，供 get/createReadStream 还原
          thumb: item.thumb || "",
          type: calcFileType(strmName, false),
          raw_url: "",
        })
      }
      // 其他类型跳过
    }
    return result
  }

  async list(_v: string, physicalPath: string): Promise<FileItem[]> {
    const path = physicalPath || "/"
    // 对齐 Go `if utils.PathEqual(path,"/") && !d.autoFlatten { return d.listRoot() }`。
    //
    // ⚠️ 偏离点：Go 在 autoFlatten 时**跳过** listRoot，直接走 getRootAndPath，
    // 而那条路是坏的（见 getRootAndPath 注释）。这里改为**无论展平与否都返回
    // listRoot**，使单路径配置的根目录也能列出映射名（`移动CAS`），与 Go
    // 多路径配置的表现一致。
    if (path === "/" || path === "") {
      const items: FileItem[] = []
      for (const k of this.pathMap.keys()) {
        items.push({
          name: k,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: "",
          type: 1,
          raw_url: "",
        })
      }
      return items
    }

    const [root, sub] = getRootAndPath(path, this.autoFlatten, this.oneKey)

    const dsts = this.pathMap.get(root)
    if (!dsts) throw new Error(`[Strm] path not found: ${path}`)

    const merged: FileItem[] = []
    const seen = new Set<string>()
    for (const dst of dsts) {
      const remote = this.remotes.get(dst)
      if (!remote) continue
      const reqPath = joinPath(dst, sub)
      const items = await this.listRemote(dst, sub)
      for (const converted of await this.convert(reqPath, items)) {
        if (!seen.has(converted.name)) {
          seen.add(converted.name)
          merged.push(converted)
        }
      }
    }
    return sortFileItems(merged, "name", "asc")
  }

  /**
   * 与 Go `(d *Strm) Get` **严格同序**（顺序本身就是语义）：
   *
   *   func (d *Strm) Get(ctx, path) (model.Obj, error) {
   *     root, sub := d.getRootAndPath(path)
   *     dsts, ok := d.pathMap[root]
   *     if !ok { return nil, errs.ObjectNotFound }
   *     for _, dst := range dsts {
   *       reqPath := stdpath.Join(dst, sub)
   *       obj, err := fs.Get(ctx, reqPath, &fs.GetArgs{NoLog: true})   // ① 先查底层真实文件
   *       if err != nil { continue }
   *       size := int64(0)
   *       if !obj.IsDir() { size = obj.GetSize(); path = reqPath }     // ② 命中真实文件
   *       return &model.Object{Path: path, Name: obj.GetName(), Size: size, ...}, nil
   *     }
   *     if strings.HasSuffix(path, ".strm") { return nil, errs.NotSupport }  // ③ 交给上层走 List
   *     return nil, errs.ObjectNotFound
   *   }
   *
   * ⚠️ 顺序至关重要：Go **先查底层真实文件**，只有全部失败才认为它是虚拟 `.strm`。
   * 此前 CF 版反过来先判 `.strm` 后缀，会让本该命中的真实文件走错分支。
   */
  async get(_v: string, physicalPath: string): Promise<FileItem> {
    const path = physicalPath || "/"

    // ① 先查底层真实文件（对齐 Go `fs.Get(dst+sub)`）
    const [root, sub] = getRootAndPath(path, this.autoFlatten, this.oneKey)
    const dsts = this.pathMap.get(root) || []
    for (const dst of dsts) {
      const remote = this.remotes.get(dst)
      if (!remote) continue
      const remotePath = joinPath(remote.physical, sub)
      try {
        const item = await remote.driver.get("", remotePath)
        if (item) {
          // 对齐 Go `model.Object.Path`：把**虚拟路径**回填到条目上。
          // strm 的 `linkUrl()` 需要用它拼 `/p{EncodePath(virtualPath)}`，
          // 与 Go `Link` 分支 ③ 里 `file.GetPath()` 的语义一致。
          return { ...item, path }
        }
      } catch {
        // 尝试下一个映射
      }
    }

    // ② 底层没找到：以 `.strm` 结尾则从（虚拟）列表里找
    if (path.endsWith(".strm")) {
      const dir = dirname(path)
      const name = basename(path)
      const items = await this.list("", dir)
      const item = items.find((i) => i.name === name)
      if (!item) throw new Error(`[Strm] not found: ${path}`)
      return item
    }
    throw new Error(`[Strm] not found: ${path}`)
  }

  async mkdir(): Promise<void> {
    throw new Error("[Strm] mkdir is not supported")
  }
  async rename(): Promise<void> {
    throw new Error("[Strm] rename is not supported")
  }
  async remove(): Promise<void> {
    throw new Error("[Strm] remove is not supported")
  }
  async move(): Promise<void> {
    throw new Error("[Strm] move is not supported")
  }
  async copy(): Promise<void> {
    throw new Error("[Strm] copy is not supported")
  }
  async put(): Promise<void> {
    throw new Error("[Strm] put is not supported")
  }

  /** .strm 文件内容：可播放直链 URL */
  async createReadStream(
    physicalPath: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const path = physicalPath || "/"
    const dir = dirname(path)
    const name = basename(path)
    const items = await this.list("", dir)
    const item = items.find((i) => i.name === name)
    if (!item || !item.sign) throw new Error(`[Strm] not found: ${path}`)
    const link = await this.getLink(item.sign)
    const bytes = new TextEncoder().encode(link)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  /**
   * 与 Go `(d *Strm) Link` 对齐 —— 返回真实文件（`.cas` / `.mkv` 等）的下载地址。
   *
   *   func (d *Strm) Link(ctx, file, args) (*model.Link, error) {
   *     if file.GetID() == "strm" {                       // ① 虚拟 .strm 文件
   *       link := d.getLink(ctx, file.GetPath())
   *       return &model.Link{RangeReader: ...}, nil       //    → 内容就是那行 URL
   *     }
   *     if common.GetApiUrl(ctx) == "" { args.Redirect = false }
   *     reqPath := file.GetPath()
   *     link, _, err := d.link(ctx, reqPath, args)        // ② 查底层
   *     if err != nil { return nil, err }
   *     if link == nil {                                  // ③ 走代理
   *       return &model.Link{URL: fmt.Sprintf("%s/p%s?sign=%s",
   *         common.GetApiUrl(ctx),
   *         utils.EncodePath(reqPath, true),
   *         sign.Sign(reqPath))}, nil
   *     }
   *     resultLink := *link
   *     resultLink.SyncClosers = utils.NewSyncClosers(link)
   *     return &resultLink, nil
   *   }
   *
   * ⚠️ 分支 ③ 是 strm 驱动的**常态**：strm 的 Config 里 `OnlyProxy: true`
   * 使 `common.ShouldProxy()` **恒为 true**，于是 `d.link()` 永远返回
   * `(nil, obj, nil)` —— 即 `link == nil` 永远成立。
   *
   * 结论：**strm 驱动下，所有真实文件的下载地址恒为
   * `{apiUrl}/p{EncodePath(path,true)}?sign={sign(path)}`（代理地址），
   * 而不是底层驱动给出的 CDN 直链。**
   */
  async linkUrl(virtualPath: string): Promise<string> {
    const reqPath = virtualPath.startsWith("/") ? virtualPath : "/" + virtualPath
    const encoded = goEncodePath(reqPath)
    const sign = await this.signPath(reqPath)
    const configured = (this.addition.siteUrl || "").replace(/\/+$/, "")
    const apiUrl = configured || this.resolvedSiteUrl()
    return `${apiUrl}/p${encoded}?sign=${sign}`
  }
}
