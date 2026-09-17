/**
 * 139 驱动的「路径 → 目录 ID」持久化索引
 *
 * ## 为什么需要它
 * 139 的接口只能按 `catalogID`（目录 ID）列目录，**不支持按路径直接定位**。
 * 因此解析 `/电影/欧美电影/某片` 这种路径，朴素做法要逐层发 3 次请求；
 * 而 Workers 单请求的子请求数有限（免费版 50 次，出站并发仅 6 条），
 * 深层路径很容易把配额耗尽，最终表现为边缘节点拒绝请求（难以诊断的 503）。
 *
 * 本模块把「已解析过的路径 → ID」记下来，命中时**零网络请求**返回。
 *
 * ## 两层缓存
 * - **进程内 Map**（`memoryIndex`）：同一 isolate 内最快，命中即返回；
 * - **KV**（键前缀 `opencas_139_idx_`）：跨 isolate / 跨请求复用，
 *   因为 CF Workers 的模块级变量会被负载均衡到不同实例。
 *
 * ## 写入节流
 * 索引变动只标脏（`dirtyKeys`）+ 防抖（`FLUSH_DEBOUNCE_MS`）后回写 KV，
 * 避免播放/浏览热路径上每次列目录都写一次 KV。
 *
 * ## 请求级预算
 * 单次请求最多读 `MAX_KV_LOADS_PER_REQUEST` 个键（`kvLoadsThisRequest`），
 * 防止一次请求里连读多个存储的索引把配额吃光。请求结束由
 * `resetPathIndexRequestBudget()` 归还额度 —— 不重置的话计数会跨请求累积，
 * 跑几次之后就永远读不到 KV 了。
 */

/** KV 中的键前缀，避免与其他模块的键冲突 */
const KV_PREFIX = "opencas_139_idx_"

/**
 * 单个存储的索引条目数上限。
 * 超出后按 `ts`（最近使用时间）淘汰最旧的，防止 KV 单值无限膨胀。
 */
const MAX_ENTRIES = 5000

/** 进程内索引：storageKey → (规范化路径 → {id, ts}) */
const memoryIndex = new Map<string, Record<string, PathIndexEntry>>()

/** 待回写 KV 的 storageKey 集合 */
const dirtyKeys = new Set<string>()

/** 防抖计时器句柄 */
let flushTimer: any = null

/** 写 KV 的防抖窗口（毫秒） */
const FLUSH_DEBOUNCE_MS = 300

/** KV binding 缓存，避免每次读写都探一遍存储后端 */
let kvBindingCache: { binding: any; at: number } | null = null

/** KV binding 缓存的存活时间（毫秒） */
const KV_BINDING_TTL_MS = 60_000

/** 本请求已尝试读取的 storageKey（同一请求内不重复读同一个键） */
const kvAttemptedKeys = new Set<string>()

/** 单次请求最多读取几个 KV 索引键 */
const MAX_KV_LOADS_PER_REQUEST = 2

/** 本请求已消耗的 KV 读取额度 */
let kvLoadsThisRequest = 0

export interface PathIndexEntry {
  /** 目录 ID */
  id: string
  /** 写入时间戳，用于 LRU 淘汰 */
  ts: number
}

export interface PathIndexOptions {
  /** 驱动配置（含 authorization，用于在无 storageId 时兜底生成 key） */
  addition: any
  /** 存储 id：同一账号配多个存储时用于隔离索引 */
  storageId?: any
  /** 环境绑定（CF Workers 的 env），用于取 KV */
  env?: any
}

/**
 * 规范化路径：去掉重复斜杠与首尾斜杠，保证索引键一致。
 * 例：`电影//欧美电影/` → `/电影/欧美电影`；空路径 → `/`
 */
export function normalizeIndexPath(path: string): string {
  const clean = "/" + (path || "").split("/").filter(Boolean).join("/")
  return clean === "/" ? "/" : clean
}

/** 拼接父子路径，始终产出规范化形式 */
export function joinIndexPath(parent: string, name: string): string {
  const p = normalizeIndexPath(parent)
  return p === "/" ? `/${name}` : `${p}/${name}`
}

/** 短哈希（djb2 变体），把 authorization 这类长串压成短 key */
function hashShort(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

/**
 * 计算索引所属的 key。
 * 优先用 storageId（同一账号可配多个存储，必须隔离）；
 * 没有 storageId 时退化到 authorization 的短哈希。
 */
function storageKeyOf(addition: any, storageId?: any): string {
  if (storageId !== undefined && storageId !== null && String(storageId) !== "") {
    return String(storageId)
  }
  return `acc_${addition?.authorization ? hashShort(addition.authorization) : "default"}`
}

/** 读进程内索引（可能为空） */
function memGet(storageKey: string): Record<string, PathIndexEntry> | undefined {
  return memoryIndex.get(storageKey)
}

/** 读进程内索引，不存在则创建空表 */
function memEnsure(storageKey: string): Record<string, PathIndexEntry> {
  let m = memoryIndex.get(storageKey)
  if (!m) {
    m = {}
    memoryIndex.set(storageKey, m)
  }
  return m
}

/**
 * 取 KV binding（带 TTL 缓存）。
 * 存储后端由 store 子系统按部署环境决定（KV / Blob / D1 / Durable Object …），
 * 这里统一通过 `getKvBinding` 探测；探测失败返回 null，索引退化为纯内存。
 */
async function getBinding(env?: any): Promise<any> {
  if (kvBindingCache && Date.now() - kvBindingCache.at < KV_BINDING_TTL_MS) {
    return kvBindingCache.binding
  }
  try {
    const mod: any = await import("../../internal/model/store/json")
    const { binding, mode } = await mod.getKvBinding(env)
    if (!binding || mode === "none") return null
    kvBindingCache = { binding, at: Date.now() }
    return binding
  } catch {
    return null
  }
}

/**
 * 从 KV 读索引。
 * 受两级保护：同一请求内同一 key 只读一次；整个请求最多读 MAX_KV_LOADS_PER_REQUEST 次。
 * 读失败一律返回 null（索引是加速手段，不该让主流程失败）。
 */
async function kvLoad(
  storageKey: string,
  env?: any,
): Promise<Record<string, PathIndexEntry> | null> {
  if (kvAttemptedKeys.has(storageKey)) return null
  if (kvLoadsThisRequest >= MAX_KV_LOADS_PER_REQUEST) return null
  kvAttemptedKeys.add(storageKey)
  kvLoadsThisRequest++

  const binding = await getBinding(env)
  if (!binding) return null
  try {
    const raw = await binding.get(`${KV_PREFIX}${storageKey}`)
    if (!raw) return null
    const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw))
    if (!parsed || typeof parsed !== "object") return null
    return parsed
  } catch {
    return null
  }
}

/** 回写索引到 KV（尽力而为，失败静默） */
async function kvSave(
  storageKey: string,
  map: Record<string, PathIndexEntry>,
  env?: any,
): Promise<void> {
  const binding = await getBinding(env)
  if (!binding) return
  try {
    await binding.put(`${KV_PREFIX}${storageKey}`, JSON.stringify(map))
  } catch {
    // 忽略：写失败下次还会重试
  }
}

/** 标脏并安排一次防抖回写 */
function markDirty(storageKey: string): void {
  dirtyKeys.add(storageKey)
  scheduleBackgroundFlush()
}

/**
 * 安排后台回写。
 * 用 setTimeout 防抖合并密集写入；在 Node 环境下 unref 掉，
 * 避免这个计时器把进程挂住（CF Workers 无此问题）。
 */
function scheduleBackgroundFlush(): void {
  if (flushTimer) return
  try {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushPathIndex().catch(() => {})
    }, FLUSH_DEBOUNCE_MS)
    const t = flushTimer
    if (t && typeof t.unref === "function") t.unref()
  } catch {
    // 忽略：没有 setTimeout 的环境下退化为不自动回写
  }
}

/**
 * 立即把脏索引刷进 KV。
 * 超过 MAX_ENTRIES 时按最近使用时间淘汰最旧条目。
 * 驱动在 `close()` 时会显式调用一次（传入 env）。
 */
export async function flushPathIndex(env?: any): Promise<void> {
  if (dirtyKeys.size === 0) return
  const keys = Array.from(dirtyKeys)
  dirtyKeys.clear()
  for (const key of keys) {
    const map = memGet(key)
    if (!map) continue
    const paths = Object.keys(map)
    if (paths.length > MAX_ENTRIES) {
      paths.sort((a, b) => map[a].ts - map[b].ts)
      const drop = paths.length - MAX_ENTRIES
      for (let i = 0; i < drop; i++) delete map[paths[i]]
    }
    await kvSave(key, map, env)
  }
}

/**
 * 归还本请求消耗的 KV 读取预算。
 * **必须在每个请求的收尾调用**，否则计数跨请求累积，
 * 之后所有请求都不再读 KV，索引退化为纯内存（等于失效）。
 *
 * 注意只重置计数、**不重置 `kvAttemptedKeys`**：
 * 去重集合按 storageKey 记录，同一请求内重复访问同一存储本就不该重复读 KV。
 */
export function resetPathIndexRequestBudget(): void {
  kvLoadsThisRequest = 0
}

/** 查一次索引（先内存后 KV），未命中返回 null */
export async function lookupPathId(
  path: string,
  opts: PathIndexOptions,
): Promise<string | null> {
  const key = storageKeyOf(opts.addition, opts.storageId)
  const p = normalizeIndexPath(path)

  const mem = memGet(key)
  if (mem && mem[p]) return mem[p].id

  const fromKv = await kvLoad(key, opts.env)
  if (fromKv) {
    const merged = memGet(key)
    if (merged) {
      // 内存里已有部分数据：只补缺失的键，不覆盖（内存版本可能更新）
      for (const k of Object.keys(fromKv)) {
        if (!merged[k]) merged[k] = fromKv[k]
      }
      if (merged[p]) return merged[p].id
    } else {
      memoryIndex.set(key, fromKv)
      if (fromKv[p]) return fromKv[p].id
    }
  }
  return null
}

/**
 * 在多个候选路径中找**第一个命中**的，返回命中的路径与 ID。
 *
 * 用于「从最深的已知前缀起跳」：把路径的所有前缀一次性列出来问索引，
 * 取最深的那个已解析前缀作为起点，而不是每层都从根开始。
 * 注意：必须一次性查，不能在循环里逐个 await —— 那样每个前缀都会
 * 走一遍 KV 读取，把请求预算瞬间打满。
 */
export async function lookupFirstHit(
  paths: string[],
  opts: PathIndexOptions,
): Promise<{ path: string; id: string } | null> {
  if (!paths.length) return null
  const key = storageKeyOf(opts.addition, opts.storageId)
  const map = await loadIndexOnce(key, opts.env)
  if (!map) return null
  for (const raw of paths) {
    const p = normalizeIndexPath(raw)
    const hit = map[p]
    if (hit) return { path: p, id: hit.id }
  }
  return null
}

/** 取整个索引表：内存优先，其次 KV，都没有则建空表 */
async function loadIndexOnce(
  storageKey: string,
  env?: any,
): Promise<Record<string, PathIndexEntry>> {
  const mem = memGet(storageKey)
  if (mem) return mem
  const fromKv = await kvLoad(storageKey, env)
  if (fromKv) {
    memoryIndex.set(storageKey, fromKv)
    return fromKv
  }
  return memEnsure(storageKey)
}

/** 记录单个路径 → ID 的映射 */
export function rememberPathId(
  path: string,
  id: string,
  opts: PathIndexOptions,
): void {
  if (!id) return
  const key = storageKeyOf(opts.addition, opts.storageId)
  const p = normalizeIndexPath(path)
  const map = memEnsure(key)
  const exist = map[p]
  if (exist && exist.id === id) return // 无变化，不标脏
  map[p] = { id, ts: Date.now() }
  markDirty(key)
}

/**
 * 批量记录某目录下的所有子目录。
 *
 * 数据来自**同一次 list 响应**，属于零额外成本的顺带收益：
 * 后续深入访问这些子目录时可直接命中索引，省掉整段逐层解析。
 */
export function rememberChildren(
  parentPath: string,
  children: Array<{ name: string; id: string }>,
  opts: PathIndexOptions,
): void {
  if (!children.length) return
  const key = storageKeyOf(opts.addition, opts.storageId)
  const map = memEnsure(key)
  let changed = false
  for (const c of children) {
    if (!c.id || !c.name) continue
    const p = joinIndexPath(parentPath, c.name)
    const exist = map[p]
    if (exist && exist.id === c.id) continue
    map[p] = { id: c.id, ts: Date.now() }
    changed = true
  }
  if (changed) markDirty(key)
}
