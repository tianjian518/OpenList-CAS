/**
 * 豆包新驱动（doubao_new）
 *
 * 基于飞书 space API 的豆包网盘驱动，支持直链播放。
 * 与旧驱动 `doubao` 的区别：旧驱动走抖音豆包公开接口，本驱动走飞书接口，
 * 能拿到可直接播放的下载地址。鉴别方式见 internal/op/storage.ts 的注册表。
 *
 * 对应 Go 版 drivers/doubao_new。
 */

import { StorageDriver, calcFileType, type FileItem } from "../../internal/driver/base"
import { ClientDoubaoNew, type DoubaoNode } from "./util"

/** 节点类型：文件夹 */
const NODE_TYPE_FOLDER = 0
/** 节点类型：豆包笔记（非实体文件，无下载直链） */
const NODE_TYPE_NOTE = 22
/** 节点类型：特殊项（不可下载） */
const NODE_TYPE_SPECIAL = 30

/** 解析体积字段（可能是字符串，非法值归零） */
function parseSize(size: any): number {
  if (!size) return 0
  const v = Number.parseInt(size, 10)
  return Number.isFinite(v) ? v : 0
}

/** 该类型是否可下载（笔记与特殊项不可） */
function isDownloadable(nodeType: number): boolean {
  return nodeType !== NODE_TYPE_NOTE && nodeType !== NODE_TYPE_SPECIAL
}

/** 把飞书节点转成统一的 FileItem */
function nodeToFileItem(node: DoubaoNode): FileItem {
  const isDir = node.type === NODE_TYPE_FOLDER
  const modified = node.edit_time
    ? new Date(node.edit_time * 1000).toISOString()
    : new Date().toISOString()
  const created = node.create_time
    ? new Date(node.create_time * 1000).toISOString()
    : modified

  const item: FileItem = {
    name: node.name,
    size: parseSize(node.extra?.size),
    is_dir: isDir,
    created,
    modified,
    sign: node.node_token || node.token || node.obj_token || "",
    type: isDir ? 1 : calcFileType(node.name, false),
    raw_url: "",
  }

  // 不可下载的类型提前给出原因，避免前端拿到空 raw_url 无从解释
  if (!isDir && !isDownloadable(node.type)) {
    item.raw_url_error =
      node.type === NODE_TYPE_NOTE
        ? "该条目是豆包笔记（非实体文件），无下载直链"
        : "该条目类型不支持下载"
  }
  return item
}

export interface DriverDoubaoNewAddition {
  cookie: string
  app_id?: string
  root_folder_id?: string
  /** 用于解密 feishu_dpop_keypair 的密钥，配置后才能自动续签 */
  dpop_key_secret?: string
  auth_client_id?: string
  auth_client_type?: string
  auth_scope?: string
  auth_sdk_source?: string
  auth_sdk_version?: string
  share_link?: boolean | string
  ignore_jwt_check?: boolean | string
}

export class DriverDoubaoNew implements StorageDriver {
  private client: ClientDoubaoNew
  private rootFolderId: string

  /**
   * 路径 → node_token 缓存。
   * list() 要按路径逐级解析，同一请求内（如列目录后再取详情）可省掉重复的网络往返。
   */
  private pathTokenCache = new Map<string, string>()

  constructor(addition: DriverDoubaoNewAddition) {
    this.client = new ClientDoubaoNew(addition)
    this.rootFolderId = (addition.root_folder_id || "").trim()
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  /** 去掉前后斜杠、逐段解码的规范路径 */
  static normPath(p: string): string {
    return (p || "")
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg)
        } catch {
          return seg
        }
      })
      .join("/")
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentToken = await this.resolveToken(physicalPath)
    const nodes = await this.client.listAllChildren(parentToken)

    const out: FileItem[] = []
    for (const node of nodes) {
      // 服务端偶尔会把父节点自身也塞进列表，必须排除，否则会列出「自己」
      if (node.node_token && node.node_token === parentToken) continue
      if (node.type === NODE_TYPE_FOLDER && node.obj_token === parentToken) continue
      if (!node.name) continue
      out.push(nodeToFileItem(node))
    }
    return out
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = DriverDoubaoNew.normPath(physicalPath)

    // 根目录没有对应节点，直接构造
    if (!clean) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.rootFolderId,
        type: 1,
        raw_url: "",
      }
    }

    const parts = clean.split("/")
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")

    const parentToken = await this.resolveToken(parentPath)
    const nodes = await this.client.listAllChildren(parentToken)
    const node = nodes.find((n) => n.name === name)

    if (node) {
      const item = nodeToFileItem(node)
      // 仅对可下载的实体文件取直链；取失败降级为 raw_url_error，不抛出
      if (!item.is_dir && isDownloadable(node.type)) {
        try {
          item.raw_url = await this.client.buildDownloadUrl(node.obj_token!)
        } catch (e: any) {
          item.raw_url_error = e?.message
        }
      }
      return item
    }

    // 名字没找到：可能调用方直接给了 token，再试一次
    try {
      const token = await this.resolveToken(clean)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: token,
        type: 1,
        raw_url: "",
      }
    } catch {
      return {
        name,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: calcFileType(name, false),
        raw_url: "",
        raw_url_error: "文件不存在",
      }
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const clean = DriverDoubaoNew.normPath(physicalPath)
    const parts = clean.split("/")
    const name = parts.pop() || "新建文件夹"
    const parentPath = "/" + parts.join("/")
    const parentToken = await this.resolveToken(parentPath)

    const node = await this.client.createFolder(parentToken, name)
    if (node?.node_token) {
      this.pathTokenCache.set(clean, node.node_token)
    }
  }

  async rename(_virtualPath: string, physicalPath: string, newName: string): Promise<void> {
    const clean = DriverDoubaoNew.normPath(physicalPath)
    const parts = clean.split("/")
    const oldName = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")

    const target = await this.findNode(parentPath, oldName)
    if (!target) {
      throw new Error(`[DoubaoNew] 找不到待重命名对象: ${clean}`)
    }

    if (target.type === NODE_TYPE_FOLDER) {
      await this.client.renameFolder(
        target.node_token || target.token || target.obj_token!,
        newName,
      )
    } else {
      await this.client.renameFile(target.obj_token || target.token!, newName)
    }
    // 路径已变，缓存失效
    this.pathTokenCache.delete(clean)
  }

  async remove(_virtualPath: string, physicalPath: string, names: string[]): Promise<void> {
    const clean = DriverDoubaoNew.normPath(physicalPath)

    // 先收集全部 token 再一次性批量删除，避免逐个发请求
    const tokens: string[] = []
    for (const name of names || []) {
      const node = await this.findNode(clean ? "/" + clean : "/", name)
      if (!node) continue
      const token = node.node_token || node.token || node.obj_token
      if (token) tokens.push(token)
    }
    if (tokens.length === 0) return

    await this.client.removeObj(tokens)

    for (const name of names || []) {
      this.pathTokenCache.delete(clean ? `${clean}/${name}` : name)
    }
  }

  async move(
    _srcDir: string,
    dstDir: string,
    names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const srcClean = DriverDoubaoNew.normPath(srcPhysical)
    const dstClean = DriverDoubaoNew.normPath(dstDir)
    const dstToken = await this.resolveToken(dstClean)

    for (const name of names || []) {
      const node = await this.findNode(srcClean ? "/" + srcClean : "/", name)
      if (!node) continue
      const token = node.node_token || node.token || node.obj_token
      if (!token) continue
      await this.client.moveObj(token, dstToken)
      this.pathTokenCache.delete(srcClean ? `${srcClean}/${name}` : name)
    }
  }

  /**
   * 豆包官方驱动未实现 Copy（Go 版同样返回 errs.NotImplement）。
   * 用「下载 + 重新上传」实现代价过高且易丢数据，故明确不支持。
   */
  async copy(): Promise<void> {
    throw new Error("[DoubaoNew] 暂不支持复制（官方驱动同样未实现）")
  }

  /** 分片上传流程尚未移植，明确报错而不是静默失败 */
  async put(): Promise<void> {
    throw new Error("[DoubaoNew] 暂不支持上传")
  }

  /**
   * 按路径逐级解析出 node_token。
   *
   * 飞书没有「按路径查 ID」的接口，只能从根逐层列目录比对名字，
   * 因此每层都会写回缓存 —— 下次访问同层路径可直接命中。
   */
  private async resolveToken(physicalPath: string): Promise<string> {
    const clean = DriverDoubaoNew.normPath(physicalPath)
    if (!clean) return this.rootFolderId
    if (this.pathTokenCache.has(clean)) return this.pathTokenCache.get(clean)!

    const parts = clean.split("/")
    let currentToken = this.rootFolderId
    let walked = ""

    for (const part of parts) {
      const nodes = await this.client.listAllChildren(currentToken)

      const target = nodes.find(
        (n) =>
          n.name === part &&
          (n.type === NODE_TYPE_FOLDER || n.node_token === part || n.obj_token === part),
      )

      if (!target) {
        // 名字匹配失败时，可能 part 本身就是 token（调用方直接传 ID）
        const byToken = nodes.find((n) => n.node_token === part || n.obj_token === part)
        if (!byToken) {
          throw new Error(
            `[DoubaoNew] 路径不存在: ${clean}（在 "${walked || "/"}" 下找不到 "${part}"）`,
          )
        }
        currentToken = byToken.node_token || byToken.obj_token!
      } else {
        currentToken = target.node_token || target.obj_token!
      }

      walked = walked ? `${walked}/${part}` : part
      this.pathTokenCache.set(walked, currentToken)
    }
    return currentToken
  }

  /** 在指定父路径下按名字找节点 */
  private async findNode(parentPath: string, name: string): Promise<DoubaoNode | undefined> {
    const parentToken = await this.resolveToken(parentPath)
    const nodes = await this.client.listAllChildren(parentToken)
    return nodes.find((n) => n.name === name)
  }
}
