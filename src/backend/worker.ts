import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"
import { setEnvCtx } from "./internal/model/db"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }

/**
 * 定时任务：清理 139 CAS 播放遗留的临时副本。
 *
 * ## 为什么必须有这个定时任务
 *
 * 139 CAS 播放要先把真实文件"秒传"还原到云盘的 `TEMP` 目录，播完再删。
 * 但删除这件事在 Workers 上**天然不可靠**：
 *
 *   1. `ctx.waitUntil` 只保证响应结束后约 30 秒，而清理延迟是 120 秒；
 *   2. isolate 随时可能被回收，未执行完的定时器直接丢失；
 *   3. 播放热路径上做清扫会显著增加子请求数，反而触发 503 超限。
 *
 * 所以"播放后自动删"只能算尽力而为，真正的兜底必须是独立于请求
 * 生命周期的定时触发 —— 这正是 `scheduled` handler 的用途。
 *
 * ## 安全性
 *
 * - 只清理 `TEMP` 目录下**带 `TEMP_139CAS_` 前缀**的文件，
 *   即本驱动自己产生的副本；
 * - NAS 版（Go）用的是 `139STRM_TEMP` 目录，与这里完全不同，
 *   不会被误删；
 * - 即便 `TEMP` 被人放了别的文件，前缀不匹配也不会动。
 *
 * ## 部署要求（重要）
 *
 * 需要在 wrangler 配置里声明 cron 触发器，否则本函数永不执行。
 * 示例（每 2 小时一次，注意 cron 的步长写法用斜杠分隔）：
 *
 *   "triggers": { "crons": ["0 0/2 * * *"] }
 *
 * 建议每 1~3 小时一次：频率太低会导致 TEMP 堆积，
 * 太高则浪费子请求配额（且回收站本身也会自动清理）。
 */
async function scheduled(
  // 用 any 而非 ScheduledEvent/ExecutionContext：本工程未依赖
  // @cloudflare/workers-types，声明这些全局类型会导致 tsc 报错。
  _event: any,
  env: any,
  ctx: any,
): Promise<void> {
  // 定时任务没有请求上下文，需要手动注入 env 才能读数据库
  setEnvCtx(env)

  // 让 DB 层能拿到 env（部分驱动依赖该全局）
  ;(globalThis as any).__cas_ctx__ = ctx

  try {
    // 延迟 import：避免把 CAS 模块链拉进冷启动的关键路径
    const { getStorages } = await import("./internal/model/db")
    const { sweepTempFilesAll } = await import("./drivers/139/cas/restore")

    const storages = await getStorages()
    const targets = (storages || []).filter(
      (s: any) => s.driver === "139" && s.addition?.cas_play_enabled !== false,
    )

    let total = 0
    for (const s of targets) {
      try {
        const { Yun139ApiClient } = await import("./drivers/139/util")
        const client = new Yun139ApiClient(s.addition)
        await client.init?.()

        const rootId =
          s.addition?.root_folder_id ||
          (client.isPersonalNew() ? "/" : "")

        total += await sweepTempFilesAll(client, rootId)
      } catch (e) {
        // 单个存储失败不影响其它存储
        console.error(`[cron] 清理 139 CAS 临时文件失败 (storage=${s.id}):`, e)
      }
    }

    console.log(`[cron] 139 CAS 临时文件清理完成，共删除 ${total} 个`)
  } catch (e) {
    console.error("[cron] 139 CAS 临时文件清理任务异常:", e)
  }
}

export default {
  fetch: app.fetch,
  scheduled,
}
