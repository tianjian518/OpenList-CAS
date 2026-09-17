/**
 * 豆包新驱动（doubao_new）的 HTTP 客户端
 *
 * ## 与「doubao」旧驱动的区别
 * 旧驱动走抖音豆包的公开 API（Cookie 鉴权）；本驱动走**飞书 space API**，
 * 能拿到可直链播放的下载地址，代价是要处理 DPoP 鉴权与 CSRF。
 *
 * ## 关键点
 * - **DPoP**：每个请求独立签一个短时效 proof（详见 auth.ts），
 *   静态 dpop 过期后必须靠私钥续签，否则 401。
 * - **CSRF**：飞书的写操作（建目录/改名/移动/删除）要求 `x-csrftoken`。
 *   首次常返回 403 且此时才下发 `_csrf_token`，所以要「失败后重试一次」，
 *   不能直接报错。见 `requestWithCsrf`。
 * - **翻页**：`listChildren` 单页最多 50 条，靠 `last_label` 游标翻页。
 *   `has_more` 为真但游标没前进时必须停，否则死循环。
 *
 * 对应 Go 版 drivers/doubao_new/util.go。
 */

import {
  generateDPoPToken,
  normalizeDPoPURL,
  parseEncryptedDPoPKeyPair,
  parseJWTPayload,
  shouldRefreshJWT,
  trimTokenScheme,
} from "./auth"

/** 飞书 space API 的基址 */
const BASE_URL = "https://my.feishu.cn"
/** 下载流专用基址（与 space API 不同域） */
const DOWNLOAD_BASE_URL = "https://internal-api-drive-stream.feishu.cn"
/** 豆包站点，用于 biz_auth 与 storage 查询 */
const DOUBAO_URL = "https://www.doubao.com"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * 列目录时请求的对象类型。
 * 22 = 豆包笔记（非实体文件，不可下载），仍允许列出以便用户看到。
 */
const DEFAULT_OBJ_TYPES = ["124", "0", "12", "30", "123", "22"]

/** 从 Cookie 串里取某个键的值 */
export function getCookieValue(cookie: string, name: string): string {
  for (const part of (cookie || "").split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ""
}

/** 宽松布尔转换：兼容 true/"true"/"1" */
export function toBool(v: any): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") return v === "true" || v === "1"
  return false
}

interface RequestInitLike {
  query?: Record<string, any>
  contentType?: string
  body?: any
  extraHeaders?: Record<string, string>
}

export interface DoubaoNode {
  name: string
  type: number
  node_token?: string
  obj_token?: string
  token?: string
  edit_time?: number
  create_time?: number
  extra?: { size?: string | number }
}

export class ClientDoubaoNew {
  addition: any
  cookie: string
  appId: string
  authClientId: string
  authClientType: string
  authScope: string
  authSdkSource: string
  authSdkVersion: string
  shareLink: boolean
  ignoreJWTCheck: boolean

  /** 当前 access token（不含 DPoP 前缀） */
  authorization = ""
  /** 从 Cookie 取到的静态 dpop（可能已过期） */
  dpopStatic = ""
  /** 由 feishu_dpop_keypair 解密出的私钥；有它才能自主续签 */
  dpopKeyPair: CryptoKey | null = null
  dpopPublicJwk: { x: string; y: string } | null = null
  /** 服务端下发的 _csrf_token，写请求复用 */
  csrfToken = ""

  constructor(addition: any) {
    this.addition = addition
    this.cookie = (addition.cookie || "").trim()
    this.appId = addition.app_id || "497858"
    this.authClientId = addition.auth_client_id || ""
    this.authClientType = addition.auth_client_type || ""
    this.authScope = addition.auth_scope || ""
    this.authSdkSource = addition.auth_sdk_source || ""
    this.authSdkVersion = addition.auth_sdk_version || ""
    this.shareLink = toBool(addition.share_link)
    this.ignoreJWTCheck = toBool(addition.ignore_jwt_check)
  }

  /**
   * 初始化：从 Cookie 提取认证信息，尝试解密 DPoP 密钥对。
   *
   * 解密失败**不抛错**（仅告警）：没有私钥时仍可用静态 dpop 工作，
   * 只是过期后无法自动续签。因密钥缺失就让整个存储挂掉过于激进。
   */
  async init(): Promise<void> {
    if (!this.cookie) throw new Error("[DoubaoNew] cookie is required")

    const rawAuth = getCookieValue(this.cookie, "LARK_SUITE_ACCESS_TOKEN")
    if (rawAuth) this.authorization = trimTokenScheme(rawAuth)

    const rawDpop = getCookieValue(this.cookie, "LARK_SUITE_DPOP")
    if (rawDpop) this.dpopStatic = rawDpop.trim()

    const keypairStr = getCookieValue(this.cookie, "feishu_dpop_keypair")
    const secret = this.addition.dpop_key_secret || ""
    if (keypairStr && secret) {
      try {
        const dec = await parseEncryptedDPoPKeyPair(keypairStr, secret)
        this.dpopKeyPair = dec.privateKey
        this.dpopPublicJwk = dec.publicJwk
      } catch (e: any) {
        console.warn("[DoubaoNew] failed to decrypt dpop key pair:", e?.message)
      }
    }

    if (!this.authorization && !this.dpopStatic) {
      throw new Error(
        "[DoubaoNew] cookie 中缺少 LARK_SUITE_ACCESS_TOKEN，请重新抓取完整 Cookie",
      )
    }
  }

  /** 自动续签所需的附加字段是否齐全（缺一不可，否则 biz_auth 必失败） */
  hasAuthAdditions(): boolean {
    return (
      !!this.addition.dpop_key_secret &&
      !!this.authClientId &&
      !!this.authClientType &&
      !!this.authScope &&
      !!this.authSdkSource &&
      !!this.authSdkVersion
    )
  }

  /** 组装 Authorization 头的值 */
  resolveAuthorization(): string {
    return this.authorization ? "DPoP " + this.authorization : ""
  }

  /**
   * 为指定请求生成 dpop 头。
   * 有私钥 → 动态签发（推荐）；否则退回静态 dpop（过期即失效）。
   */
  async resolveDpopForRequest(method: string, rawURL: string): Promise<string> {
    if (this.dpopKeyPair && this.dpopPublicJwk) {
      const proof = await generateDPoPToken({
        keyPair: this.dpopKeyPair,
        publicJwk: this.dpopPublicJwk,
        htm: method.toUpperCase(),
        htu: normalizeDPoPURL(rawURL),
      })
      return proof.dpopToken
    }

    const staticDpop = this.dpopStatic
    if (!staticDpop) return ""

    if (!this.ignoreJWTCheck) {
      try {
        const pl = parseJWTPayload(staticDpop)
        if (pl.exp && pl.exp > 0) {
          const now = Math.floor(Date.now() / 1000)
          if (pl.exp <= now + 5) {
            throw new Error(
              "[DoubaoNew] 静态 dpop 已过期，请配置 dpop_key_secret 以启用自动刷新",
            )
          }
        }
      } catch (e: any) {
        // 只在「确实过期」时向上抛；解析失败说明它不是标准 JWT，按原样使用
        if (e?.message?.includes("已过期")) throw e
      }
    }
    return staticDpop
  }

  /** 用 dpop + Cookie 换取新的业务 access token（对应 Go 版 fetchBizAuth） */
  async fetchBizAuth(dpop: string): Promise<string> {
    const reqUrl = DOUBAO_URL + "/passport/user/biz_auth/"
    const headers: Record<string, string> = {
      accept: "application/json, text/javascript",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": UA,
    }
    if (this.cookie) {
      headers.cookie = this.cookie
      const csrf = getCookieValue(this.cookie, "passport_csrf_token")
      if (csrf) headers["x-tt-passport-csrf-token"] = csrf
    }
    const oldAuth = this.resolveAuthorization()
    if (oldAuth) headers.authorization = oldAuth
    if (dpop) headers.dpop = dpop

    const values = new URLSearchParams()
    values.set("client_id", this.authClientId)
    values.set("client_type", this.authClientType)
    values.set("scope", this.authScope)
    values.set("d_pop", dpop)

    const qs = new URLSearchParams()
    qs.set("aid", this.appId)
    qs.set("account_sdk_source", this.authSdkSource)
    qs.set("sdk_version", this.authSdkVersion)

    const resp = await fetch(reqUrl + "?" + qs.toString(), {
      method: "POST",
      headers,
      body: values.toString(),
    })
    const json: any = await resp.json()
    if (json.message !== "success" || !json.data?.access_token) {
      throw new Error(
        `[DoubaoNew] biz auth 失败: ${json.message}: ${json.data?.description || ""}`,
      )
    }
    return json.data.access_token
  }

  /**
   * 按需刷新 authorization 并返回可用的 Authorization 头。
   *
   * 刷新失败一律**静默回退**到旧 token：宁可让本次请求带着旧 token 试一次，
   * 也不要因为续签环节的临时故障让用户操作直接失败。
   */
  async resolveAuthorizationForRequest(method: string, rawURL: string): Promise<string> {
    if (!shouldRefreshJWT(this.authorization)) {
      return this.resolveAuthorization()
    }
    // 缺私钥 / Cookie / 附加字段时无从续签，直接用现状
    if (!this.dpopKeyPair || !this.cookie || !this.hasAuthAdditions()) {
      return this.resolveAuthorization()
    }
    try {
      const refreshDpop = await this.resolveDpopForRequest(method, rawURL)
      if (!refreshDpop) return this.resolveAuthorization()
      const newToken = await this.fetchBizAuth(refreshDpop)
      this.authorization = trimTokenScheme(newToken)
      return this.resolveAuthorization()
    } catch {
      return this.resolveAuthorization()
    }
  }

  /** 给请求头注入 authorization 与 dpop */
  async applyAuthHeaders(
    headers: Record<string, string>,
    method: string,
    rawURL: string,
  ): Promise<void> {
    const auth = await this.resolveAuthorizationForRequest(method, rawURL)
    if (auth) headers.authorization = auth
    const dpop = await this.resolveDpopForRequest(method, rawURL)
    if (dpop) headers.dpop = dpop
  }

  /** 拼查询串（支持数组值重复出现） */
  private buildURL(fullUrl: string, query?: Record<string, any>): string {
    if (!query) return fullUrl
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) {
        for (const item of v) qs.append(k, item)
      } else {
        qs.set(k, v)
      }
    }
    return fullUrl + (fullUrl.includes("?") ? "&" : "?") + qs.toString()
  }

  /**
   * 统一请求方法（对应 Go 版 request）。
   * 非 JSON 响应与业务 code≠0 都会抛出带上下文的错误 —— 把响应体前 200 字符
   * 带进错误信息，否则线上只能看到「解析失败」而无法判断是登录态失效还是接口变更。
   */
  async request(path: string, method: string, init?: RequestInitLike): Promise<any> {
    const fullUrl = BASE_URL + path
    const headers: Record<string, string> = {
      accept: "*/*",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "user-agent": UA,
    }
    await this.applyAuthHeaders(headers, method, fullUrl)
    if (init?.contentType) headers["content-type"] = init.contentType
    if (init?.extraHeaders) Object.assign(headers, init.extraHeaders)

    const url = this.buildURL(fullUrl, init?.query)
    const resp = await fetch(url, { method, headers, body: init?.body })
    const text = await resp.text()

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(
        `[DoubaoNew] 响应解析失败 (status: ${resp.status}, content-type: ${resp.headers.get(
          "content-type",
        )}): ${text.slice(0, 200)}`,
      )
    }
    if (typeof json.code === "number" && json.code !== 0) {
      const msg = json.msg || json.message || `code ${json.code}`
      throw new Error(`[DoubaoNew] API 错误 (code: ${json.code}): ${msg}`)
    }
    return json
  }

  /**
   * 带 CSRF 重试的请求。
   *
   * 飞书的写操作要求 `x-csrftoken`，但该 token 往往**只在第一次 403 响应的
   * Set-Cookie 里下发**。因此流程是：先发一次 → 若判定为 CSRF 缺失，则
   * 提取 token 带上重发一次。这不属于「重试容错」，而是完成握手的必要步骤。
   */
  async requestWithCsrf(path: string, method: string, init?: RequestInitLike): Promise<any> {
    const first = await this.rawRequest(path, method, init)
    if (!first.csrfRequired) {
      return this.decodeResp(first)
    }
    const csrf = this.extractCsrfToken(first)
    if (!csrf) return this.decodeResp(first)
    this.csrfToken = csrf
    const second = await this.rawRequest(path, method, init, csrf)
    return this.decodeResp(second)
  }

  /** 发一次原始请求，标记是否属于 CSRF 校验失败 */
  private async rawRequest(
    path: string,
    method: string,
    init?: RequestInitLike,
    csrfOverride?: string,
  ): Promise<{ status: number; text: string; setCookie: string | null; csrfRequired: boolean }> {
    const fullUrl = BASE_URL + path
    const headers: Record<string, string> = {
      accept: "*/*",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "user-agent": UA,
    }
    await this.applyAuthHeaders(headers, method, fullUrl)
    if (init?.contentType) headers["content-type"] = init.contentType
    const csrf = csrfOverride || this.csrfToken
    if (csrf) headers["x-csrftoken"] = csrf

    const url = this.buildURL(fullUrl, init?.query)
    const resp = await fetch(url, { method, headers, body: init?.body })
    const text = await resp.text()
    const setCookie = resp.headers.get("set-cookie")
    const csrfRequired =
      resp.status === 403 || text.toLowerCase().includes("csrf token error")
    return { status: resp.status, text, setCookie, csrfRequired }
  }

  /** 从响应 Set-Cookie（或自身 Cookie）里提取 _csrf_token */
  private extractCsrfToken(res: { setCookie: string | null }): string {
    if (res.setCookie) {
      const v = getCookieValue(res.setCookie, "_csrf_token")
      if (v) return v
    }
    return getCookieValue(this.cookie, "_csrf_token")
  }

  /** 解析业务响应，code≠0 抛错 */
  private decodeResp(res: { status: number; text: string }): any {
    let json: any
    try {
      json = JSON.parse(res.text)
    } catch {
      throw new Error(
        `[DoubaoNew] 响应解析失败 (status: ${res.status}): ${res.text.slice(0, 200)}`,
      )
    }
    if (typeof json.code === "number" && json.code !== 0) {
      const msg = json.msg || json.message || `code ${json.code}`
      throw new Error(`[DoubaoNew] API 错误 (code: ${json.code}): ${msg}`)
    }
    return json
  }

  /** 列出目录子项（一页，最多 50 条） */
  async listChildren(parentToken: string, lastLabel?: string, length = 50): Promise<any> {
    const query: Record<string, any> = {
      obj_type: DEFAULT_OBJ_TYPES,
      length: String(length),
      rank: "0",
      asc: "0",
      min_length: "40",
      thumbnail_width: "1028",
      thumbnail_height: "1028",
      thumbnail_policy: "4",
    }
    if (parentToken) query.token = parentToken
    if (lastLabel) query.last_label = lastLabel
    const resp = await this.request("/space/api/explorer/doubao/children/list/", "GET", {
      query,
    })
    return resp.data
  }

  /**
   * 列出目录全部子项（自动翻页）。
   *
   * 三重防死循环：迭代上限 100 次；`has_more` 为假即停；
   * **游标未前进也停**（服务端可能返回相同的 last_label）。
   * 节点既可能散在 `entities.nodes`，也可能由 `node_list` 给 token 索引，
   * 两种形态都要兼容。
   */
  async listAllChildren(parentToken: string): Promise<DoubaoNode[]> {
    const length = 50
    const nodes: DoubaoNode[] = []
    let lastLabel = ""

    for (let i = 0; i < 100; i++) {
      const data = await this.listChildren(parentToken, lastLabel, length)
      if (!data) break

      if (data.node_list && data.node_list.length > 0) {
        for (const token of data.node_list) {
          const node = data.entities?.nodes?.[token]
          if (node) nodes.push(node)
        }
      } else if (data.entities?.nodes) {
        for (const node of Object.values(data.entities.nodes)) nodes.push(node as DoubaoNode)
      }

      if (!data.has_more || !data.last_label || data.last_label === lastLabel) break
      lastLabel = data.last_label
    }
    return nodes
  }

  /** 取文件信息（预印/校验用） */
  async getFileInfo(fileToken: string): Promise<any> {
    const resp = await this.request("/space/api/box/file/info/", "POST", {
      contentType: "application/json",
      body: JSON.stringify({
        caller: "explorer",
        file_token: fileToken,
        mount_point: "explorer",
        option_params: ["preview_meta", "check_cipher"],
      }),
    })
    return resp.data
  }

  /** 存储用量 */
  async getUserStorage(): Promise<any> {
    const headers: Record<string, string> = {
      accept: "*/*",
      origin: DOUBAO_URL,
      referer: DOUBAO_URL + "/",
      "agw-js-conv": "str",
      "content-type": "application/json",
      "user-agent": UA,
    }
    await this.applyAuthHeaders(
      headers,
      "POST",
      DOUBAO_URL + "/alice/aispace/facade/get_user_storage",
    )
    if (this.cookie) headers.cookie = this.cookie

    const resp = await fetch(DOUBAO_URL + "/alice/aispace/facade/get_user_storage", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    })
    const json: any = await resp.json()
    if (json.code !== 0) {
      throw new Error(
        `[DoubaoNew] API 错误 (code: ${json.code}): ${json.msg || json.message || ""}`,
      )
    }
    return json.data
  }

  /**
   * 生成下载直链。
   * 飞书下载流不认 Cookie，凭据走查询串（authorization + dpop），
   * 且 dpop 的 htu 必须对**这个带参数的 URL** 签名 —— 所以顺序不能颠倒。
   */
  async buildDownloadUrl(objToken: string, method = "GET"): Promise<string> {
    const targetUrl =
      DOWNLOAD_BASE_URL + "/space/api/box/stream/download/all/" + objToken + "/"
    const auth = await this.resolveAuthorizationForRequest(method, targetUrl)
    const dpop = await this.resolveDpopForRequest(method, targetUrl)
    if (!auth || !dpop) {
      throw new Error("[DoubaoNew] 缺少 authorization 或 dpop")
    }
    const q = new URLSearchParams()
    q.set("authorization", auth)
    q.set("dpop", dpop)
    return targetUrl + "?" + q.toString()
  }

  /** 下载直链所需的额外请求头（缺 Referer 会被拒） */
  downloadHeaders(): Record<string, string> {
    return { Referer: DOUBAO_URL + "/", "User-Agent": UA }
  }

  /** 是否配置为使用分享链接 */
  isShareLink(): boolean {
    return this.shareLink
  }

  // ------------------------------------------------------------------
  // 写操作
  // ------------------------------------------------------------------

  /** 新建文件夹，返回新节点（响应结构不稳定，做了多路兜底） */
  async createFolder(parentToken: string, name: string): Promise<DoubaoNode> {
    const data = new URLSearchParams()
    data.set("name", name)
    data.set("source", "0")
    if (parentToken) data.set("parent_token", parentToken)

    const resp = await this.requestWithCsrf("/space/api/explorer/v2/create/folder/", "POST", {
      contentType: "application/x-www-form-urlencoded",
      body: data.toString(),
    })

    const nodeList = resp.data?.node_list || []
    let node: any
    if (nodeList.length > 0) node = resp.data?.entities?.nodes?.[nodeList[0]]
    if (!node) {
      const all = Object.values(resp.data?.entities?.nodes || {})
      node = all[0]
    }
    if (!node) throw new Error("[DoubaoNew] 新建文件夹失败：响应为空")

    // 不同接口返回的 token 字段名不一致，补齐成统一形态
    if (!node.node_token) node.node_token = node.token || node.obj_token
    if (!node.obj_token) node.obj_token = node.token || node.node_token
    return node
  }

  /** 重命名文件夹（按 node_token） */
  async renameFolder(token: string, name: string): Promise<void> {
    if (!token) throw new Error("[DoubaoNew] 重命名文件夹缺少 token")
    const data = new URLSearchParams()
    data.set("token", token)
    data.set("name", name)
    await this.requestWithCsrf("/space/api/explorer/v2/rename/", "POST", {
      contentType: "application/x-www-form-urlencoded",
      body: data.toString(),
    })
  }

  /** 重命名文件（按 file_token） */
  async renameFile(fileToken: string, name: string): Promise<void> {
    if (!fileToken) throw new Error("[DoubaoNew] 重命名文件缺少 file_token")
    await this.request("/space/api/box/file/update_info/", "POST", {
      contentType: "application/json",
      body: JSON.stringify({ file_token: fileToken, name }),
    })
  }

  /** 移动到目标目录 */
  async moveObj(srcToken: string, destToken: string): Promise<void> {
    if (!srcToken) throw new Error("[DoubaoNew] 移动缺少源 token")
    const data = new URLSearchParams()
    data.set("src_token", srcToken)
    if (destToken) data.set("dest_token", destToken)
    await this.requestWithCsrf("/space/api/explorer/v2/move/", "POST", {
      contentType: "application/x-www-form-urlencoded",
      body: data.toString(),
    })
  }

  /** 删除对象（支持批量），有 task_id 时等待异步任务完成 */
  async removeObj(tokens: string[]): Promise<void> {
    if (!tokens || tokens.length === 0) {
      throw new Error("[DoubaoNew] 删除缺少 token")
    }
    const resp = await this.requestWithCsrf("/space/api/explorer/v3/remove/", "POST", {
      contentType: "application/json",
      body: JSON.stringify({ tokens, apply: 1 }),
    })
    const taskId = resp.data?.task_id
    if (taskId) await this.waitTask(taskId)
  }

  /**
   * 轮询异步任务直到完成。
   * Go 版是 1 秒 × 120 次（最长 2 分钟）；Workers 有 CPU/时长限制，
   * 这里压缩为 800ms × 15 次（约 12 秒），避免拖垮整个请求。
   * 超时抛错而不是静默返回：删除未确认完成就报成功会让用户误以为已删。
   */
  async waitTask(taskId: string): Promise<void> {
    const maxAttempts = 15
    let lastErr: any = null
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 800))
      try {
        const status = await this.getTaskStatus(taskId)
        if (status.is_fail) {
          throw new Error(`[DoubaoNew] 异步任务失败: ${taskId}`)
        }
        if (status.is_finish) return
      } catch (e) {
        lastErr = e
      }
    }
    if (lastErr) throw lastErr
    throw new Error(`[DoubaoNew] 异步任务超时: ${taskId}`)
  }

  /** 查询异步任务状态 */
  async getTaskStatus(taskId: string): Promise<any> {
    if (!taskId) throw new Error("[DoubaoNew] 查询任务缺少 task_id")
    const resp = await this.request("/space/api/explorer/v2/task/", "GET", {
      query: { task_id: taskId },
    })
    return resp.data
  }

  /** 导出当前认证状态（诊断用） */
  debugState(): any {
    let tokenExp: number | null = null
    try {
      const pl = parseJWTPayload(this.authorization)
      tokenExp = pl.exp ?? null
    } catch {
      // token 不是标准 JWT 时无从取 exp
    }
    return {
      hasAuthorization: !!this.authorization,
      authLength: this.authorization.length,
      hasStaticDpop: !!this.dpopStatic,
      hasKeyPair: !!this.dpopKeyPair,
      tokenExp,
      tokenExpIso: tokenExp ? new Date(tokenExp * 1000).toISOString() : null,
    }
  }
}
