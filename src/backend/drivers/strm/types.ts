// Strm driver types — 将底层网盘的视频文件以 .strm 文件形式暴露
export interface StrmAddition {
  paths: string
  siteUrl?: string
  PathPrefix?: string
  downloadFileTypes?: string
  filterFileTypes?: string
  encodePath?: boolean
  withoutUrl?: boolean
  withSign?: boolean
  root_folder_path?: string
  /**
   * 配置版本号（对齐 Go `Addition.Version`）。
   *
   * Go 在 `Init` 里判断 `Version != 5` 时补齐默认扩展名列表并设
   * `PathPrefix = "/d"`，然后写回 5 —— 这是给老配置/网友分享的配置做的
   * 向后兼容。缺了它，旧配置生成的 `.strm` 会丢掉 `/d` 前缀而无法播放。
   */
  Version?: number
  /** 对齐 Go `SaveStrmToLocal` 等字段（当前 CF 版仅作占位，不落盘） */
  SaveStrmToLocal?: boolean
  SaveStrmLocalPath?: string
  SaveLocalMode?: string
}
