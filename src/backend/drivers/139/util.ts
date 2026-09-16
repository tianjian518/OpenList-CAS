import CryptoJS from "crypto-js"
import {
  Yun139Addition,
  QueryRoutePolicyResp,
  Yun139DiskResp,
  Yun139DownloadResp,
  Yun139FileItem,
  Yun139StorageDetailsResp,
  PersonalListResp,
  PersonalDownloadResp,
  PersonalFileItem,
} from "./types"

/**
 * 与官方 Go 实现 `url.QueryEscape` + 补充转义保持一致的编码。
 *
 * 关键：Go 的 `encodeURIComponent` 语义还转义 `!'()*`，
 * 而 JS 内置的 encodeURIComponent 不转义它们。签名是对"编码后的字符串"
 * 做排序再哈希，任何一个字符编码不一致都会导致签名校验失败。
 */
export function encodeURIComponentCustom(str: string): string {
  let r = encodeURIComponent(str)
  r = r.replace(/!/g, "%21")
  r = r.replace(/'/g, "%27")
  r = r.replace(/\(/g, "%28")
  r = r.replace(/\)/g, "%29")
  r = r.replace(/\*/g, "%2A")
  return r
}

export function md5(str: string): string {
  return CryptoJS.MD5(str).toString(CryptoJS.enc.Hex)
}

export function calSign(body: string, ts: string, randStr: string): string {
  const enc = encodeURIComponentCustom(body)
  const sorted = enc.split("").sort().join("")
  const words = CryptoJS.enc.Utf8.parse(sorted)
  const b64 = CryptoJS.enc.Base64.stringify(words)
  const res = md5(b64) + md5(`${ts}:${randStr}`)
  return md5(res).toUpperCase()
}

export function randomString(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let res = ""
  for (let i = 0; i < len; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return res
}

export function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export class Yun139ApiClient {
  private addition: Yun139Addition
  public personalHost = "https://yun.139.com"
  public familyHost = "https://yun.139.com"
  public groupHost = "https://yun.139.com"
  public account = ""

  /**
   * 当前生效的授权串（不含 `Basic ` 前缀）。
   *
   * token 刷新后会被就地更新 —— 这是让储存长期不掉线的关键：
   * 139 的 token 有过期时间，官方客户端会在过期前换取新的 token
   * 并写回配置，这里采取同样的策略。
   */
  private authValue = ""
  /** 是否已执行过初始化（路由策略只需查一次） */
  private inited = false

  constructor(addition: Yun139Addition) {
    this.addition = addition
    this.authValue = this.normalizeAuth(addition.authorization || "")
    this.extractAccount()
  }

  private normalizeAuth(auth: string): string {
    let a = (auth || "").trim()
    if (a.startsWith("Basic ")) a = a.slice(6).trim()
    return a
  }

  private extractAccount(): void {
    if (!this.authValue) return
    try {
      const decoded = CryptoJS.enc.Base64.parse(this.authValue).toString(
        CryptoJS.enc.Utf8,
      )
      const splits = decoded.split(":")
      if (splits.length >= 2) {
        this.account = splits[1]
      }
    } catch {
      // Ignored
    }
  }

  public getAuthString(): string {
    return this.authValue
  }

  /** 当前授权串（供驱动回写到储存配置，实现持久化续期） */
  public getAuthorization(): string {
    return this.authValue
  }

  isPersonalNew(): boolean {
    return !this.addition.type || this.addition.type === "personal_new"
  }

  isFamily(): boolean {
    return this.addition.type === "family"
  }

  isGroup(): boolean {
    return this.addition.type === "group"
  }

  getHost(): string {
    if (this.isFamily()) return this.familyHost
    if (this.isGroup()) return this.groupHost
    return this.personalHost
  }

  /**
   * 通用请求头（`user-njs` / 家庭云等公共域名使用）。
   */
  private buildCommonHeaders(bodyStr: string): Record<string, string> {
    const ts = formatTime(new Date())
    const randStr = randomString(16)
    const sign = calSign(bodyStr, ts, randStr)
    return {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "CMS-DEVICE": "default",
      Authorization: `Basic ${this.authValue}`,
      "mcloud-channel": "1000101",
      "mcloud-client": "10701",
      "mcloud-sign": `${ts},${randStr},${sign}`,
      "mcloud-version": "7.14.0",
      Origin: "https://yun.139.com",
      Referer: "https://yun.139.com/w/",
      "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
      "x-huawei-channelSrc": "10000034",
      "x-inner-ntwk": "2",
      "x-m4c-caller": "PC",
      "x-m4c-src": "10002",
      "x-SvcType": this.isFamily() ? "2" : "1",
      "Inner-Hcy-Router-Https": "1",
    }
  }

  /**
   * 个人盘新版专用请求头。
   *
   * 与公共头的差异（缺任一都会导致接口返回"资源不存在"）：
   *   - `Mcloud-Route: 001` 必带
   *   - 整套 `X-Yun-*` 头
   *   - `Caller: web`
   */
  private buildPersonalHeaders(bodyStr: string): Record<string, string> {
    const ts = formatTime(new Date())
    const randStr = randomString(16)
    const sign = calSign(bodyStr, ts, randStr)
    return {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Authorization: `Basic ${this.authValue}`,
      Caller: "web",
      "Cms-Device": "default",
      "Mcloud-Channel": "1000101",
      "Mcloud-Client": "10701",
      "Mcloud-Route": "001",
      "Mcloud-Sign": `${ts},${randStr},${sign}`,
      "Mcloud-Version": "7.14.0",
      "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
      "x-huawei-channelSrc": "10000034",
      "x-inner-ntwk": "2",
      "x-m4c-caller": "PC",
      "x-m4c-src": "10002",
      "x-SvcType": this.isFamily() ? "2" : "1",
      "X-Yun-Api-Version": "v1",
      "X-Yun-App-Channel": "10000034",
      "X-Yun-Channel-Source": "10000034",
      "X-Yun-Client-Info":
        "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||",
      "X-Yun-Module-Type": "100",
      "X-Yun-Svc-Type": "1",
    }
  }

  /**
   * 发起一次 139 请求。
   *
   * @param uriOrUrl 相对路径或完整 URL
   * @param body 请求体
   * @param usePersonalHeaders 是否使用个人盘专用请求头（个人盘相对路径建议开启）
   */
  async request<T = any>(
    uriOrUrl: string,
    body: any,
    usePersonalHeaders = false,
  ): Promise<T> {
    const bodyStr = JSON.stringify(body || {})

    let url: string
    if (uriOrUrl.startsWith("http://") || uriOrUrl.startsWith("https://")) {
      url = uriOrUrl
    } else if (uriOrUrl.startsWith("/orchestration/")) {
      // Orchestration APIs are strictly hosted on yun.139.com
      url = `https://yun.139.com${uriOrUrl}`
    } else {
      url = `${this.getHost()}${uriOrUrl}`
    }

    const headers =
      usePersonalHeaders && !url.startsWith("https://user-njs")
        ? this.buildPersonalHeaders(bodyStr)
        : this.buildCommonHeaders(bodyStr)

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`139 Cloud API error (${res.status}): ${text.slice(0, 200)}`)
    }

    const json = (await res.json()) as any
    if (json.success === false && json.message) {
      throw new Error(`139 Cloud API error: ${json.message} [${json.code || ""}]`)
    }
    return json as T
  }

  /**
   * 刷新 token。
   *
   * 139 的授权 token 有有效期；官方做法是在过期前用旧 token 换取新 token，
   * 服务端会返回有效期（秒）与新的 accessToken。这里只在剩余时间不足
   * 阈值时才刷新，避免频繁请求。
   *
   * @returns 是否成功刷新
   */
  async refreshToken(force = false): Promise<boolean> {
    if (!this.authValue) return false

    const inner = this.parseAuth()
    if (!inner) return false

    // 剩余时间充足则跳过（授权串第 4 段是签发时间戳，单位毫秒）
    if (!force && inner.issuedAt > 0) {
      const ageMs = Date.now() - inner.issuedAt
      const remainMs = 30 * 24 * 3600 * 1000 - ageMs
      if (remainMs > 15 * 24 * 3600 * 1000) return false
    }

    try {
      const res = await fetch(
        "https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do",
        {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: `<root><token>${inner.token}</token><account>${inner.account}</account><clienttype>656</clienttype></root>`,
        },
      )
      const text = await res.text()
      const retCode = (text.match(/<return>([^<]*)<\/return>/) || [])[1]
      if (retCode !== "0") {
        return false
      }
      const newToken = (text.match(/<token>([^<]+)<\/token>/) || [])[1]
      if (!newToken) return false

      this.authValue = btoa(`pc:${inner.account}:${newToken}`)
      return true
    } catch {
      return false
    }
  }

  /** 解析授权串，取账号 / token / 签发时间 */
  private parseAuth(): {
    account: string
    token: string
    issuedAt: number
  } | null {
    try {
      const decoded = atob(this.authValue)
      const parts = decoded.split(":")
      if (parts.length < 3) return null
      const account = parts[1]
      const token = parts[2]
      const seg = token.split("|")
      const issuedAt = seg.length >= 4 ? Number(seg[3]) : 0
      return {
        account,
        token,
        issuedAt: Number.isFinite(issuedAt) ? issuedAt : 0,
      }
    } catch {
      return null
    }
  }

  async init(): Promise<void> {
    if (!this.authValue) {
      throw new Error("139 Cloud Authorization is required")
    }
    if (this.inited) return

    // 1) 先续期 token —— 过期前换取新的，避免中途掉线
    try {
      await this.refreshToken(false)
    } catch {
      // 续期失败不阻断，后续请求会用旧 token 碰运气
    }

    // 2) 查询路由策略，拿到真实的主机地址
    //
    //    注意：个人盘的接口主机**不能**硬编码为 yun.139.com，
    //    必须由本接口下发的 httpsUrl 决定（含 /hcy 之类的路由前缀）。
    try {
      const routeRes = await this.request<QueryRoutePolicyResp>(
        "https://user-njs.yun.139.com/user/route/qryRoutePolicy",
        {
          userInfo: {
            userType: 1,
            accountType: 1,
            accountName: this.account,
          },
          modAddrType: 1,
        },
      )

      if (routeRes.data?.routePolicyList) {
        for (const policy of routeRes.data.routePolicyList) {
          if (!policy.httpsUrl) continue
          if (policy.modName === "personal") {
            this.personalHost = policy.httpsUrl
          } else if (policy.modName === "group") {
            this.groupHost = policy.httpsUrl
          } else if (policy.modName === "family") {
            this.familyHost = policy.httpsUrl
          }
        }
      }
    } catch (e) {
      console.warn(
        "[139] queryRoutePolicy warning, fallback to default host:",
        e,
      )
    }

    this.inited = true
  }

  async listFiles(folderId = ""): Promise<{
    files: Yun139FileItem[]
    folders: Array<{
      catalogID: string
      catalogName: string
      updateTime?: string
    }>
  }> {
    if (this.isPersonalNew()) {
      let nextPageCursor = ""
      const allItems: PersonalFileItem[] = []
      const parentFileId = folderId || this.addition.root_folder_id || "/"

      do {
        const res = await this.request<PersonalListResp>(
          "/file/list",
          {
            parentFileId,
            pageInfo: {
              pageCursor: nextPageCursor,
              pageSize: 100,
            },
            orderBy: "updated_at",
            orderDirection: "DESC",
            imageThumbnailStyleList: ["Small", "Large"],
          },
          true,
        )

        const items = res.data?.items || []
        allItems.push(...items)
        nextPageCursor = res.data?.nextPageCursor || ""
      } while (nextPageCursor)

      const folders = allItems
        .filter((i) => i.type === "folder")
        .map((i) => ({
          catalogID: i.fileId,
          catalogName: i.name,
          updateTime: i.updatedAt,
        }))

      const files: Yun139FileItem[] = allItems
        .filter((i) => i.type !== "folder")
        .map((i) => ({
          contentID: i.fileId,
          contentName: i.name,
          contentSize: i.size,
          updateTime: i.updatedAt,
          createTime: i.createdAt,
          thumbnailURL: i.thumbnailUrls?.[0]?.url,
        }))

      return { files, folders }
    }

    return this.getDisk(folderId)
  }

  async getDisk(catalogId = ""): Promise<{
    files: Yun139FileItem[]
    folders: Array<{
      catalogID: string
      catalogName: string
      updateTime?: string
    }>
  }> {
    const res = await this.request<Yun139DiskResp>(
      "/orchestration/personalCloud/catalog/v1.0/getDisk",
      {
        catalogID: catalogId || "",
        sortDirection: 1,
        filterType: 0,
        catalogSortType: 0,
        contentSortType: 0,
        startNumber: 1,
        endNumber: 5000,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )

    const diskResult = res.data?.getDiskResult
    return {
      files: diskResult?.fileList || [],
      folders: diskResult?.catalogList || [],
    }
  }

  async getDownloadUrl(contentIdOrFileId: string): Promise<string> {
    if (this.isPersonalNew()) {
      const res = await this.request<PersonalDownloadResp>(
        "/file/getDownloadUrl",
        {
          fileId: contentIdOrFileId,
        },
        true,
      )
      // 直链优先级：cdnUrl（CDN 直链）> url（EOS 中转链）
      //
      // 为什么不能看 cdnSwitch：
      //   139 返回的 `url` 是 EOS 中转链，路径里带
      //   `response-content-disposition=attachment`，客户端（尤其网易爆米花
      //   这类播放器）会把它当成"下载文件"而不是"播放视频"，表现为
      //   "获取播放地址失败"。
      //   而 `cdnUrl` 是 yun.mcloud.139.com/cdnv1/... 的干净直链，无下载头。
      //
      // 官方 Go 版（drivers/139/util.go personalGetLink）同样是**无条件**
      // 优先 cdnUrl，只在 cdnUrl 为空时才回退 url —— 不看 cdnSwitch。
      // 此前 TS 版写成 `cdnSwitch ? cdnUrl : url`，只要 cdnSwitch 为 false
      // 就会去取带 attachment 的 EOS 链，这正是播放失败的直接原因。
      const url = res.data?.cdnUrl || res.data?.url
      if (!url) {
        throw new Error("Empty download URL received from 139 Cloud")
      }
      return url
    }

    const res = await this.request<Yun139DownloadResp>(
      "/orchestration/personalCloud/uploadAndDownload/v1.0/downloadRequest",
      {
        contentID: contentIdOrFileId,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )

    const url = res.data?.downloadURL || res.data?.url
    if (!url) {
      throw new Error("Empty download URL received from 139 Cloud")
    }
    return url
  }

  async createCatalog(parentCatalogId: string, name: string): Promise<string> {
    if (this.isPersonalNew()) {
      const res = await this.request<any>(
        "/file/create",
        {
          parentFileId: parentCatalogId || this.addition.root_folder_id || "/",
          name,
          description: "",
          type: "folder",
          fileRenameMode: "force_rename",
        },
        true,
      )
      return res.data?.fileId || ""
    }

    const res = await this.request<any>(
      "/orchestration/personalCloud/catalog/v1.0/createCatalog",
      {
        parentCatalogID: parentCatalogId || "",
        catalogName: name,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
    return res.data?.catalogID || ""
  }

  /**
   * 删除文件。
   *
   * 注意：个人盘新版的删除接口是 `/recyclebin/batchTrash`（移入回收站），
   * **不是** `/file/delete`。用错路径会返回 404 + "认证失败"，
   * 极容易被误判成 token 失效。
   */
  async deleteFile(contentIdOrFileId: string): Promise<void> {
    if (this.isPersonalNew()) {
      await this.request(
        "/recyclebin/batchTrash",
        {
          fileIds: [contentIdOrFileId],
        },
        true,
      )
      return
    }

    await this.request(
      "/orchestration/personalCloud/catalog/v1.0/deleteContent",
      {
        contentID: contentIdOrFileId,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
  }

  async deleteCatalog(catalogIdOrFileId: string): Promise<void> {
    if (this.isPersonalNew()) {
      await this.request(
        "/recyclebin/batchTrash",
        {
          fileIds: [catalogIdOrFileId],
        },
        true,
      )
      return
    }

    await this.request(
      "/orchestration/personalCloud/catalog/v1.0/deleteCatalog",
      {
        catalogID: catalogIdOrFileId,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
  }

  async rename(id: string, newName: string): Promise<void> {
    if (this.isPersonalNew()) {
      await this.request(
        "/file/update",
        {
          fileId: id,
          name: newName,
          description: "",
        },
        true,
      )
      return
    }

    await this.request(
      "/orchestration/personalCloud/catalog/v1.0/updateCatalogInfo",
      {
        catalogID: id,
        catalogName: newName,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      },
    )
  }

  async getStorageDetails(): Promise<{ total?: number; used?: number }> {
    try {
      const res = await this.request<Yun139StorageDetailsResp>(
        "/orchestration/personalCloud/catalog/v1.0/getUserDomainInfo",
        {
          commonAccountInfo: {
            account: this.account,
            accountType: 1,
          },
        },
      )
      return {
        total: res.data?.totalSize,
        used: res.data?.usedSize,
      }
    } catch {
      return {}
    }
  }
}
