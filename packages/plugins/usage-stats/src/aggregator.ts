/**
 * 用量聚合的纯函数核心：会话事件流 → 单会话账目 → 跨会话汇总。
 *
 * 计费折算与上游 token-meter 的 `tokenUsage` 投影（会话底栏 StatsLine）同一套
 * 语义，而不是 `deriveTurnTokenUsage` 的 exact-or-nothing：
 * - 每条 provider 上报的 usage（`assistant/chunk` usage 或 `assistant/message`）
 *   都进账；同 (turn, step) 的后到样本替换先到的，避免流式双计；
 * - `llm/retry-started` 关掉替换槽，重试后的新尝试另计（失败尝试的用量保留）；
 * - 不要求 turn 闭合、不要求 totalTokens、不要求每个 attempt 都报缓存桶；
 * - 空 step（start 后立刻 end、没有任何 usage）不影响其他请求。
 *
 * 归因按 attempt，不按 turn：有 message.source 的进对应 (provider, model)，
 * 没有来源的（典型是失败重试尚未形成助手消息）进 unattributed。turn 内换模型
 * 会拆到各模型行。恒有：byModel 各行桶和 + unattributed === byDay 各日桶和。
 *
 * 展示口径：requests 只数以 assistant/message 结算的计费尝试；reasoning 是
 * output 子集，只展示不计入总量；总量恒用四桶和。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmRetryStartedEventData } from '@deepseek-ai/dsh-llm-retry/types'

/** 单模型 token 账目（四桶互不重叠；reasoning ⊆ output 仅展示）。 */
export interface UsageBuckets {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  /** 以 assistant/message 结算的计费尝试数（同 step 流式替换不计两次）。 */
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
  /** 无法归因到 (provider, model) 的量（无 message.source 的计费尝试）。 */
  unattributed: UsageBuckets
  /** 当前仍挂在 unattributed 下的 distinct turn 数（诊断用）。 */
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegative(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined
}

/** 事件时间可用时取本地日；否则沿用上一次见过的日（保证 byDay 与模型桶守恒）。 */
function eventDay(event: SessionEvent, fallback: string | undefined): string | undefined {
  return isFiniteNumber(event.time) ? localDateKey(event.time) : fallback
}

/**
 * 把一条 usage 样本收成四桶。input/output 缺一不可（无法计费则跳过该样本）；
 * 缓存桶缺省当 0——与投影 `bucketsFrom` 一致，绝不以「整 turn 缺一桶」抹掉其他 attempt。
 */
function bucketsFrom(usage: unknown, fromMessage: boolean): UsageBuckets | undefined {
  if (usage === null || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const uncachedInput = nonNegative(record.inputTokens)
  const output = nonNegative(record.outputTokens)
  if (uncachedInput === undefined || output === undefined) return undefined
  const reasoningRaw = nonNegative(record.reasoningTokens) ?? 0
  return {
    uncachedInput,
    cacheRead: nonNegative(record.cacheReadTokens) ?? 0,
    cacheWrite: nonNegative(record.cacheWriteTokens) ?? 0,
    output,
    reasoning: reasoningRaw > output ? 0 : reasoningRaw,
    requests: fromMessage ? 1 : 0,
  }
}

function messageRoute(message: unknown): { provider: string; model: string } | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const source = (message as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return undefined
  const provider = (source as { provider?: unknown }).provider
  const model = (source as { model?: unknown }).model
  return typeof provider === 'string' && provider.length > 0
    && typeof model === 'string' && model.length > 0
    ? { provider, model }
    : undefined
}

/** 投影替换槽：同 (turn, step) 的最新样本，retry-started 后清空以便新尝试另计。 */
interface OpenSlot {
  turn: number
  step: number
  buckets: UsageBuckets
  day: string
  key: string | undefined
}

function applySigned(target: UsageBuckets, source: UsageBuckets, sign: 1 | -1): void {
  target.uncachedInput += sign * source.uncachedInput
  target.cacheRead += sign * source.cacheRead
  target.cacheWrite += sign * source.cacheWrite
  target.output += sign * source.output
  target.reasoning += sign * source.reasoning
  target.requests += sign * source.requests
}

function ensureDay(aggregate: SessionUsageAggregate, day: string): DayBuckets {
  const existing = aggregate.byDay[day]
  if (existing !== undefined) return existing
  const created: DayBuckets = { ...emptyBuckets(), turns: 0 }
  aggregate.byDay[day] = created
  return created
}

function ensureModel(aggregate: SessionUsageAggregate, key: string): ModelBuckets {
  const existing = aggregate.byModel[key]
  if (existing !== undefined) return existing
  const created: ModelBuckets = { ...emptyBuckets(), perDay: {} }
  aggregate.byModel[key] = created
  return created
}

/**
 * 折算一个会话的完整事件日志。进行中的末尾 turn、空 step、缺 totalTokens、
 * 某次请求没报缓存读，都按投影语义计费，不再整 turn 丢弃。
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

  let last: OpenSlot | undefined
  let lastDay: string | undefined
  let openTurnDay: string | undefined
  const unattributedByTurn = new Map<number, number>()

  const touchUnattributedTurn = (turn: number, sign: 1 | -1): void => {
    const next = (unattributedByTurn.get(turn) ?? 0) + sign
    if (next <= 0) unattributedByTurn.delete(turn)
    else unattributedByTurn.set(turn, next)
  }

  const applySlot = (slot: OpenSlot, sign: 1 | -1): void => {
    const day = ensureDay(aggregate, slot.day)
    applySigned(day, slot.buckets, sign)
    if (slot.key === undefined) {
      applySigned(aggregate.unattributed, slot.buckets, sign)
      touchUnattributedTurn(slot.turn, sign)
      return
    }
    const model = ensureModel(aggregate, slot.key)
    applySigned(model, slot.buckets, sign)
    const delta = sign * bucketTotal(slot.buckets)
    const next = (model.perDay[slot.day] ?? 0) + delta
    if (next === 0) delete model.perDay[slot.day]
    else model.perDay[slot.day] = next
  }

  const closeOpenTurn = (day: string | undefined): void => {
    if (day === undefined) return
    ensureDay(aggregate, day).turns++
  }

  for (const event of events) {
    if (isFiniteNumber(event.time)) {
      if (aggregate.firstActive === undefined || event.time < aggregate.firstActive) aggregate.firstActive = event.time
      if (aggregate.lastActive === undefined || event.time > aggregate.lastActive) aggregate.lastActive = event.time
      lastDay = localDateKey(event.time)
    }
    const day = eventDay(event, lastDay)

    if (event.type === 'turn/start') {
      if (openTurnDay !== undefined) closeOpenTurn(openTurnDay)
      aggregate.turns++
      openTurnDay = day
    } else if (event.type === 'turn/end') {
      closeOpenTurn(day ?? openTurnDay)
      openTurnDay = undefined
    } else if (event.type === 'llm/retry-started') {
      const data: LlmRetryStartedEventData = event.data
      if (last !== undefined && last.turn === data.turn && last.step === data.step) {
        last = undefined
      }
    }

    let usage: unknown
    let turn: number | undefined
    let step: number | undefined
    let fromMessage = false
    let route: { provider: string; model: string } | undefined
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      ;({ turn, step } = event.data)
      usage = event.data.chunk.usage
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      ;({ turn, step, usage } = event.data)
      fromMessage = true
      route = messageRoute(event.data.message)
    } else {
      continue
    }
    if (typeof turn !== 'number' || typeof step !== 'number') continue
    const buckets = bucketsFrom(usage, fromMessage)
    if (buckets === undefined || day === undefined) continue

    const slot: OpenSlot = {
      turn,
      step,
      buckets,
      day,
      key: route === undefined ? undefined : modelKey(route.provider, route.model),
    }
    if (last !== undefined && last.turn === turn && last.step === step) {
      applySlot(last, -1)
    }
    applySlot(slot, 1)
    last = slot
  }

  closeOpenTurn(openTurnDay)
  aggregate.unattributedTurns = unattributedByTurn.size
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
