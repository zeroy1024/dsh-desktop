/**
 * 用量聚合的纯函数核心：会话事件流 → 单会话账目 → 跨会话汇总。
 *
 * 单 turn 折算完全委托上游 token-meter 的 deriveTurnTokenUsage（exact-or-
 * nothing：重试 attempt 替换而非重复计数、账目不可证明时整体拒绝），本文件
 * 只负责三件事：按 turn 边界切片、按 (provider, model) 归因、按本地日期落桶，
 * 以及把缓存行折叠成展示用汇总（streak/峰值等派生指标）。
 *
 * 归因哲学与上游一致——宁缺毋猜：
 * - turn 折算失败（缺生命周期边界/账目矛盾）→ 该 turn 只有 turns/requests
 *   计数进账，token 量丢弃（上游无法证明，我们不猜）；
 * - routes 缺失（存在无归因 attempt，如中断的失败尝试）或路由多于一个
 *   （turn 内换模型）→ 账目本身精确但无法归属单一模型，整 turn 记
 *   unattributed。因此恒有：byModel 各行桶和 + unattributed === byDay 各日
 *   桶和。
 *
 * 已知口径边界（UI 需标注）：requests 只数带 usage 报告的 assistant/message，
 * 不含被重试替换掉的中间尝试；reasoning 是 output 子集，只展示不计入总量；
 * 总量恒用四桶和（上游 totalTokens 允许 ≥ 四桶和，不采用）。
 */
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 单模型 token 账目（四桶互不重叠；reasoning ⊆ output 仅展示）。 */
export interface UsageBuckets {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  /** 带 usage 报告的 assistant/message 数（不含被重试替换的中间尝试）。 */
  requests: number
}

/** 单日账目 = 各桶 + 当日 turn 数（不分模型）。 */
export interface DayBuckets extends UsageBuckets {
  turns: number
}

/** 单模型账目 + 该模型的每日总量（趋势折线图的多序列数据源）。 */
export interface ModelBuckets extends UsageBuckets {
  /** key = 本地时区 `YYYY-MM-DD` → 该模型当日四桶和。 */
  perDay: Record<string, number>
}

/** 单会话聚合产物（usage_stats 缓存域行内核心）。 */
export interface SessionUsageAggregate {
  turns: number
  /** epoch ms；事件日志无时间时 undefined。 */
  firstActive: number | undefined
  lastActive: number | undefined
  /** key = `${provider}\u0000${model}`（\0 分隔避免 provider/model 自身含混淆字符）。 */
  byModel: Record<string, ModelBuckets>
  /** key = 本地时区 `YYYY-MM-DD`（含 unattributed 的量，保证按日总量完整）。 */
  byDay: Record<string, DayBuckets>
  /** 无法归因到单一 (provider, model) 的量。 */
  unattributed: UsageBuckets
  /** 计入 unattributed 的 turn 数（诊断用）。 */
  unattributedTurns: number
}

/** 单模型汇总行（趋势图只取 perDay 总量，不重复带四桶）。 */
export interface SummaryModelRow {
  provider: string
  model: string
  buckets: UsageBuckets
  /** key = 本地时区 `YYYY-MM-DD` → 该模型当日四桶和。 */
  perDay: Record<string, number>
  /** 有该模型用量的会话数。 */
  sessions: number
}

/** 单日汇总行。 */
export interface SummaryDayRow {
  day: string
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  requests: number
  turns: number
  /** 当日有活跃 turn 的会话数（折叠时由会话行的 byDay 键现算，不入缓存）。 */
  sessions: number
}

/** 跨会话汇总（summary 路由的响应主体）。 */
export interface UsageSummary {
  overall: {
    firstDay: string | undefined
    lastDay: string | undefined
    /** 截至今天（或昨天）的连续活跃天数；更久未活跃则为 0。 */
    currentStreak: number
    longestStreak: number
    peakDay: string | undefined
    peakTokens: number
    /** 各会话首末事件跨度之和（ms；跨会话重叠不扣减）。 */
    activeMs: number
    sessions: number
    subagentSessions: number
    turns: number
  }
  byDay: SummaryDayRow[]
  byModel: SummaryModelRow[]
  unattributed: UsageBuckets
}

/** 折叠输入：缓存行的展示视图（node 半从缓存域投影）。 */
export interface SessionUsageRowView {
  id: string
  createdAt: number
  lastActive: number
  isSubagent: boolean
  aggregate: SessionUsageAggregate
}

/** provider/model 复合键（与上游 TurnTokenUsage routes 去重同款分隔符）。 */
export function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** 本地时区日期键。 */
export function localDateKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 四桶和（展示口径的「总量」；reasoning ⊆ output 不计）。 */
export function bucketTotal(buckets: UsageBuckets): number {
  return buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite + buckets.output
}

export function emptyBuckets(): UsageBuckets {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 }
}

/** 把 source 的各桶累加进 target（就地修改）。 */
export function addBuckets(target: UsageBuckets, source: UsageBuckets): UsageBuckets {
  target.uncachedInput += source.uncachedInput
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.reasoning += source.reasoning
  target.requests += source.requests
  return target
}

/** 事件流里带 usage 报告的 assistant/message 数（展示口径的「请求数」）。 */
function countRequests(turnEvents: readonly SessionEvent[]): number {
  let count = 0
  for (const event of turnEvents) {
    if (event.type === 'assistant/message' && event.data.usage !== undefined) count++
  }
  return count
}

/** 把一个完整 turn（turn/start…turn/end）折进会话聚合。 */
function foldTurn(aggregate: SessionUsageAggregate, turnEvents: readonly SessionEvent[]): void {
  const end = turnEvents[turnEvents.length - 1]
  if (end === undefined || end.type !== 'turn/end') return
  const day = localDateKey(end.time)
  aggregate.turns++

  const dayBucket = aggregate.byDay[day] ?? { ...emptyBuckets(), turns: 0 }
  dayBucket.turns++

  const usage = deriveTurnTokenUsage(turnEvents)
  const requests = countRequests(turnEvents)
  const routes = usage?.routes
  // 精确且单一归因才进 byModel；否则账目（若可得）整体记 unattributed。
  if (usage !== undefined && routes !== undefined && routes.length === 1) {
    const route = routes[0]
    const key = modelKey(route.provider, route.model)
    const bucket = aggregate.byModel[key] ?? { ...emptyBuckets(), perDay: {} }
    bucket.uncachedInput += usage.uncachedInputTokens
    bucket.cacheRead += usage.cacheReadTokens ?? 0
    bucket.cacheWrite += usage.cacheWriteTokens ?? 0
    bucket.output += usage.outputTokens
    bucket.reasoning += usage.reasoningTokens ?? 0
    bucket.requests += requests
    bucket.perDay[day] = (bucket.perDay[day] ?? 0)
      + usage.uncachedInputTokens + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
    aggregate.byModel[key] = bucket

    dayBucket.uncachedInput += usage.uncachedInputTokens
    dayBucket.cacheRead += usage.cacheReadTokens ?? 0
    dayBucket.cacheWrite += usage.cacheWriteTokens ?? 0
    dayBucket.output += usage.outputTokens
    dayBucket.reasoning += usage.reasoningTokens ?? 0
    dayBucket.requests += requests
  } else {
    const unattributed = aggregate.unattributed
    unattributed.uncachedInput += usage?.uncachedInputTokens ?? 0
    unattributed.cacheRead += usage?.cacheReadTokens ?? 0
    unattributed.cacheWrite += usage?.cacheWriteTokens ?? 0
    unattributed.output += usage?.outputTokens ?? 0
    unattributed.reasoning += usage?.reasoningTokens ?? 0
    unattributed.requests += requests
    aggregate.unattributedTurns++

    dayBucket.uncachedInput += usage?.uncachedInputTokens ?? 0
    dayBucket.cacheRead += usage?.cacheReadTokens ?? 0
    dayBucket.cacheWrite += usage?.cacheWriteTokens ?? 0
    dayBucket.output += usage?.outputTokens ?? 0
    dayBucket.reasoning += usage?.reasoningTokens ?? 0
    dayBucket.requests += requests
  }
  aggregate.byDay[day] = dayBucket
}

/**
 * 折算一个会话的完整事件日志。未闭合的末尾 turn（进行中/崩溃残留）不折算，
 * 留给下次 revision 变化后的重扫。
 */
export function aggregateSessionEvents(events: readonly SessionEvent[]): SessionUsageAggregate {
  const aggregate: SessionUsageAggregate = {
    turns: 0,
    firstActive: undefined,
    lastActive: undefined,
    byModel: {},
    byDay: {},
    unattributed: emptyBuckets(),
    unattributedTurns: 0,
  }
  let open: SessionEvent[] | undefined
  for (const event of events) {
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      if (aggregate.firstActive === undefined || event.time < aggregate.firstActive) aggregate.firstActive = event.time
      if (aggregate.lastActive === undefined || event.time > aggregate.lastActive) aggregate.lastActive = event.time
    }
    if (event.type === 'turn/start') {
      open = [event]
      continue
    }
    // turn 边界之外的事件（header、compaction 等）不参与账目。
    if (open === undefined) continue
    open.push(event)
    if (event.type === 'turn/end') {
      foldTurn(aggregate, open)
      open = undefined
    }
  }
  return aggregate
}

/** 日期串（本地日历日）→ UTC ms。两个日历日的 UTC 差恒为 86400000 的倍数，不受 DST 影响。 */
function dayToUtcMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

/** 连续活跃天：days 升序去重后最长连跑段长度。 */
function longestStreakOf(days: readonly string[]): number {
  let longest = 0
  let run = 0
  let previous: number | undefined
  for (const day of days) {
    const time = dayToUtcMs(day)
    const consecutive = previous !== undefined && time - previous === 86_400_000
    run = consecutive ? run + 1 : 1
    if (run > longest) longest = run
    previous = time
  }
  return longest
}

/** 当前连续活跃天：末次活跃是今天或昨天时，从该点往回的连跑长度。 */
function currentStreakOf(days: readonly string[], todayLocal: string): number {
  if (days.length === 0) return 0
  const lastTime = dayToUtcMs(days[days.length - 1])
  const gap = dayToUtcMs(todayLocal) - lastTime
  if (gap !== 0 && gap !== 86_400_000) return 0
  let streak = 0
  for (let index = days.length - 1; index >= 0; index--) {
    if (index === days.length - 1) {
      streak = 1
      continue
    }
    if (dayToUtcMs(days[index + 1]) - dayToUtcMs(days[index]) !== 86_400_000) break
    streak++
  }
  return streak
}

/**
 * 把缓存行折叠成跨会话汇总。byModel 行按用量占比降序、同量按名称稳定排序；
 * nowMs 只影响 currentStreak（测试注入固定时钟）。
 */
export function foldSessionRows(rows: readonly SessionUsageRowView[], nowMs: number): UsageSummary {
  const byDay = new Map<string, SummaryDayRow>()
  const byModel = new Map<string, SummaryModelRow>()
  const unattributed = emptyBuckets()
  const overall = {
    firstDay: undefined as string | undefined,
    lastDay: undefined as string | undefined,
    currentStreak: 0,
    longestStreak: 0,
    peakDay: undefined as string | undefined,
    peakTokens: 0,
    activeMs: 0,
    sessions: 0,
    subagentSessions: 0,
    turns: 0,
  }

  for (const row of rows) {
    overall.sessions++
    if (row.isSubagent) overall.subagentSessions++
    overall.turns += row.aggregate.turns
    if (row.aggregate.firstActive !== undefined && row.aggregate.lastActive !== undefined) {
      overall.activeMs += Math.max(0, row.aggregate.lastActive - row.aggregate.firstActive)
    }
    addBuckets(unattributed, row.aggregate.unattributed)

    for (const [day, buckets] of Object.entries(row.aggregate.byDay)) {
      const target = byDay.get(day) ?? {
        day,
        uncachedInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        requests: 0,
        turns: 0,
        sessions: 0,
      }
      target.uncachedInput += buckets.uncachedInput
      target.cacheRead += buckets.cacheRead
      target.cacheWrite += buckets.cacheWrite
      target.output += buckets.output
      target.reasoning += buckets.reasoning
      target.requests += buckets.requests
      target.turns += buckets.turns
      // 该会话在此日出现过聚合桶 = 该日活跃（无论量多少）。
      target.sessions += 1
      byDay.set(day, target)
    }

    for (const [key, buckets] of Object.entries(row.aggregate.byModel)) {
      if (bucketTotal(buckets) === 0 && buckets.requests === 0) continue
      const separator = key.indexOf('\u0000')
      const provider = separator >= 0 ? key.slice(0, separator) : key
      const model = separator >= 0 ? key.slice(separator + 1) : ''
      const target = byModel.get(key) ?? { provider, model, buckets: emptyBuckets(), perDay: {}, sessions: 0 }
      addBuckets(target.buckets, buckets)
      for (const [day, total] of Object.entries(buckets.perDay)) {
        target.perDay[day] = (target.perDay[day] ?? 0) + total
      }
      target.sessions++
      byModel.set(key, target)
    }
  }

  const days = [...byDay.keys()].toSorted()
  if (days.length > 0) {
    overall.firstDay = days[0]
    overall.lastDay = days[days.length - 1]
    for (const day of days) {
      const row = byDay.get(day)
      if (row === undefined) continue
      const total = bucketTotal(row)
      if (total > overall.peakTokens) {
        overall.peakTokens = total
        overall.peakDay = day
      }
    }
    overall.longestStreak = longestStreakOf(days)
    overall.currentStreak = currentStreakOf(days, localDateKey(nowMs))
  }

  const modelRows = [...byModel.values()].toSorted((a, b) => {
    const byTotal = bucketTotal(b.buckets) - bucketTotal(a.buckets)
    if (byTotal !== 0) return byTotal
    const byRequests = b.buckets.requests - a.buckets.requests
    if (byRequests !== 0) return byRequests
    return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)
  })

  return {
    overall,
    byDay: days.map(day => byDay.get(day)).filter(row => row !== undefined),
    byModel: modelRows,
    unattributed,
  }
}
