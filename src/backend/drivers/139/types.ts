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
