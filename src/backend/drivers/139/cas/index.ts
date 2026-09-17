/**
 * 139 云盘 CAS 功能模块
 *
 * 对外统一导出，便于驱动层调用。
 */

export {
  CAS_EXT,
  decodeCas,
  encodeCas,
  deriveRealName,
  extAllowed,
  isCasName,
  normalizeAllowlist,
  toCasName,
  type CasMeta,
} from "./format"

export {
  CAS_TEMP_DIR,
  CAS_TEMP_PREFIX,
  buildPartInfos,
  ensureTempDir,
  makeTempPrefix,
  rapidCreate,
  restoreFromCas,
  safeDelete,
  sweepTempFiles,
  sweepTempFilesAll,
  type RapidResult,
} from "./restore"

export {
  CasPlayError,
  parseCasMeta,
  readCasContent,
  resolveCasPlayLink,
  shouldHandleCas,
  type CasPlayLink,
  type ResolveOpts,
} from "./player"
