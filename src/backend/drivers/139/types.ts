export interface Yun139Addition {
  authorization: string
  username?: string
  password?: string
  mail_cookies?: string
  root_folder_id?: string
  type?: "personal_new" | "family" | "group" | "personal" | "share"
  link_id?: string
  cloud_id?: string
  user_domain_id?: string
  custom_upload_part_size?: number
  report_real_size?: boolean
  use_large_thumbnail?: boolean
  use_old_stream_upload?: boolean
  order_by?: string
  order_direction?: string

  /**
   * 路径解析的最大层数上限（默认 32）。
   *
   * 139 接口只支持按父目录 ID 逐层查询，解析 N 层路径就要 N 次请求，
   * 而 Workers 单请求的子请求数有限（免费版 50 次，出站并发仅 6 条）。
   * 超过上限时 driver 会抛出明确错误，而不是耗尽配额后被边缘节点
   * 以 503 拒绝（那种失败极难诊断）。深层目录场景可调大此值。
   */
  max_path_depth?: number

  /* ---------------- CAS 播放相关配置 ---------------- */

  /** 是否启用 CAS 播放（默认启用） */
  cas_play_enabled?: boolean
  /** 播放后是否自动清理临时副本（默认启用） */
  cas_auto_cleanup?: boolean
  /** 允许播放的扩展名白名单，逗号分隔；留空使用内置视频列表 */
  cas_ext_allowlist?: string
}

export interface RoutePolicyItem {
  modName: string
  httpsUrl: string
}

export interface QueryRoutePolicyResp {
  code: string
  message: string
  success: boolean
  data: {
    routePolicyList: RoutePolicyItem[]
  }
}

export interface Yun139FileItem {
  contentID?: string
  contentName?: string
  contentSize?: number | string
  contentType?: string
  contentSuffix?: string
  createTime?: string
  updateTime?: string
  digest?: string
  thumbnailURL?: string
  bigThumbnailURL?: string
  fileType?: number
  isDir?: boolean
  caID?: string
}

export interface Yun139DiskResp {
  code: string
  message: string
  success: boolean
  data: {
    result?: {
      resultCode: string
      resultDesc: string
    }
    getDiskResult?: {
      nodeCount?: number
      fileList?: Yun139FileItem[]
      catalogList?: Array<{
        catalogID: string
        catalogName: string
        createTime?: string
        updateTime?: string
      }>
    }
  }
}

export interface Yun139DownloadResp {
  code: string
  message: string
  success: boolean
  data: {
    downloadURL?: string
    url?: string
  }
}

export interface Yun139StorageDetailsResp {
  code: string
  message: string
  success: boolean
  data: {
    catalogTotalSize?: number
    freeSize?: number
    totalSize?: number
    usedSize?: number
  }
}

export interface PersonalThumbnail {
  style?: string
  url?: string
}

export interface PersonalFileItem {
  fileId: string
  name: string
  size?: number | string
  type: "folder" | "file" | string
  createdAt?: string
  updatedAt?: string
  thumbnailUrls?: PersonalThumbnail[]
}

export interface PersonalListResp {
  code: string
  message: string
  success: boolean
  data?: {
    items?: PersonalFileItem[]
    nextPageCursor?: string
  }
}

export interface PersonalDownloadResp {
  code: string
  message: string
  success: boolean
  data?: {
    url?: string
    cdnUrl?: string
    cdnSwitch?: boolean
  }
}
