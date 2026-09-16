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
  /**
   * 是否让 .strm 里的链接走 OpenList 自身代理（`?proxy=true`）。
   *
   * 开启原因：139 的 EOS 中转链带 `Content-Disposition: attachment` 且对
   * HEAD 返回 403，播放器会判定为不可播放。代理层会改写为 inline 并把
   * HEAD 降级为 GET。代价是流量经 Worker，按需开启。
   */
  casProxy?: boolean
  root_folder_path?: string
}
