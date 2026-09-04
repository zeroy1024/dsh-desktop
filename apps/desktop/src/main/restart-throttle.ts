/**
 * restart-throttle.ts — restart-agent IPC 的冷却决策（纯 Node，可单测）。
 *
 * 渲染进程可无成本地反复 invoke restart-agent（本地 DoS / 打断在途任务），
 * 主进程不设限。这里给「被接受的 restart」之间设最小间隔：窗口期内再来
 * 的请求拒绝并记日志。语义：
 *
 *   - 只有「被接受的 restart」推进时间轴；窗口期内的拒绝不推迟下一次
 *     可用时刻——首个请求总会被接受，连点只放行第一个（若想延后放行
 *     需要记每个拒绝的到达时刻，超出本模块的最小意图）。
 *   - 决策注入时钟，单测不依赖真实时间。
 *   - 冷却独立于 supervisor 的「意外退出指数退避重启」：那是 agent 崩溃
 *     的自愈路径，不经 restart-agent IPC，不共享本闸门。
 */
export const RESTART_COOLDOWN_MS = 3_000

/** 无状态闸门：上次接受时刻由调用方持有，传 null 表示从未接受过。 */
export class RestartThrottle {
  #lastAcceptedAt: number | null = null
  #now: () => number

  /** @param now - 时钟注入；默认 Date.now，单测传假时钟。 */
  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** 上次接受的 restart 时刻；从未接受过为 null。 */
  lastAcceptedAt(): number | null {
    return this.#lastAcceptedAt
  }

  /**
   * 是否允许 restart：冷却窗口外的请求放行并记录时刻；窗口内的拒绝
   * 不推进时刻。窗口以请求到达时刻为基准：
   *   now >= lastAcceptedAt + RESTART_COOLDOWN_MS 即可放行。
   */
  allowRestart(): boolean {
    const now = this.#now()
    const last = this.#lastAcceptedAt
    if (last !== null && now - last < RESTART_COOLDOWN_MS) return false
    this.#lastAcceptedAt = now
    return true
  }
}
