/**
 * 聚合器单测：手工构造 SessionEvent fixture（形状对照上游 deriveTurnTokenUsage
 * 的 attempt 状态机），覆盖正常折算、retry、多路由、跨天、未闭合 turn、
 * 汇总折叠（streak/峰值/守恒）。
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  aggregateSessionEvents, bucketTotal, foldSessionRows, localDateKey, modelKey,
  type SessionUsageRowView,
} from '../src/aggregator.ts'

/** 事件序号自增（真实日志 seq 单调，聚合器不依赖具体值）。 */
let seq = 0

/** 宽松事件构造：data 形状由各 helper 保证符合上游状态机预期。 */
function ev(type: string, time: number, data: unknown): SessionEvent {
  seq++
  return { type, seq, time, data } as unknown as SessionEvent
}

/** 本地日历日 → 本地时区 epoch ms（与 localDateKey 互逆）。 */
function localMs(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

const DAY = '2026-09-05'
const T0 = localMs(2026, 9, 5, 10)

interface AttemptInput {
  usage: Record<string, unknown>
  provider?: string
  model?: string
}

/** 正常结算的多 step turn：每个 attempt 一个 step，message.source 归因。 */
function completedTurn(input: {
  turn: number
  start: number
  end: number
  attempts: readonly AttemptInput[]
}): SessionEvent[] {
  const events: SessionEvent[] = [ev('turn/start', input.start, { turn: input.turn })]
  for (const [index, attempt] of input.attempts.entries()) {
    const step = index + 1
    events.push(
      ev('step/start', input.start, { turn: input.turn, step }),
      ev('assistant/chunk', input.start, {
        turn: input.turn, step, chunk: { type: 'usage', usage: attempt.usage },
      }),
      ev('assistant/message', input.start, {
        turn: input.turn, step,
        message: {
          source: { kind: 'model', provider: attempt.provider ?? 'self', model: attempt.model ?? 'deepseek-v4-flash' },
        },
        usage: attempt.usage,
      }),
      ev('step/end', input.end, { turn: input.turn, step }),
    )
  }
  events.push(ev('turn/end', input.end, { turn: input.turn, reason: { kind: 'completed' } }))
  return events
}

/** 带 retry 的 turn：失败尝试（usage→finish error）→ llm/retry → 重试成功。 */
function retryTurn(input: {
  turn: number
  start: number
  end: number
  failedUsage: Record<string, unknown>
  usage: Record<string, unknown>
  provider: string
  model: string
}): SessionEvent[] {
  return [
    ev('turn/start', input.start, { turn: input.turn }),
    ev('step/start', input.start, { turn: input.turn, step: 1 }),
    ev('assistant/chunk', input.start, {
      turn: input.turn, step: 1, chunk: { type: 'usage', usage: input.failedUsage },
    }),
    ev('assistant/chunk', input.start, {
      turn: input.turn, step: 1,
      chunk: { type: 'finish', reason: { kind: 'error', error: { name: 'LlmError', code: 'X' } } },
    }),
    ev('llm/retry', input.start, {
      turn: input.turn, step: 1, retryId: 'r1', provider: input.provider, mode: 'normal', policyKey: 'p',
    }),
    ev('llm/retry-started', input.start, { turn: input.turn, step: 1, retryId: 'r1' }),
    ev('assistant/chunk', input.start, {
      turn: input.turn, step: 1, chunk: { type: 'usage', usage: input.usage },
    }),
    ev('assistant/message', input.start, {
      turn: input.turn, step: 1,
      message: { source: { kind: 'model', provider: input.provider, model: input.model } },
      usage: input.usage,
    }),
    ev('step/end', input.end, { turn: input.turn, step: 1 }),
    ev('turn/end', input.end, { turn: input.turn, reason: { kind: 'completed' } }),
  ]
}

function rowOf(id: string, aggregate: ReturnType<typeof aggregateSessionEvents>, extra: Partial<SessionUsageRowView> = {}): SessionUsageRowView {
  return {
    id,
    createdAt: aggregate.firstActive ?? 0,
    lastActive: aggregate.lastActive ?? 0,
    isSubagent: false,
    aggregate,
    ...extra,
  }
}

describe('localDateKey', () => {
  it('按本地时区格式化 YYYY-MM-DD', () => {
    expect(localDateKey(localMs(2026, 9, 5, 0))).toBe('2026-09-05')
    expect(localDateKey(localMs(2026, 12, 31, 23))).toBe('2026-12-31')
  })
})

describe('aggregateSessionEvents', () => {
  it('正常单 attempt：四桶/请求数/每日落桶/perDay 守恒', () => {
    const events = completedTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      attempts: [{ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10, reasoningTokens: 20 } }],
    })
    const aggregate = aggregateSessionEvents(events)
    expect(aggregate.turns).toBe(1)
    expect(aggregate.byModel[modelKey('self', 'deepseek-v4-flash')]).toEqual({
      uncachedInput: 100, cacheRead: 900, cacheWrite: 10, output: 50, reasoning: 20, requests: 1,
      perDay: { [DAY]: 100 + 900 + 10 + 50 },
    })
    expect(aggregate.byDay[DAY]).toEqual({
      uncachedInput: 100, cacheRead: 900, cacheWrite: 10, output: 50, reasoning: 20, requests: 1, turns: 1,
    })
    expect(aggregate.unattributed).toEqual({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 })
    expect(aggregate.firstActive).toBe(T0)
    expect(aggregate.lastActive).toBe(T0 + 60_000)
  })

  it('多 step 同模型累加；requests 按 message 数计', () => {
    const events = completedTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      attempts: [
        { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 5, totalTokens: 20 } },
        { usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 30, totalTokens: 58 } },
      ],
    })
    const aggregate = aggregateSessionEvents(events)
    expect(aggregate.turns).toBe(1)
    // turn 级缓存桶只在全部 attempt 都上报时才披露（上游 every 语义）。
    expect(aggregate.byModel[modelKey('self', 'deepseek-v4-flash')]).toMatchObject({
      uncachedInput: 30, cacheRead: 35, cacheWrite: 0, output: 13, requests: 2,
    })
  })

  it('turn 内换模型（routes>1）：账目精确但整体记 unattributed', () => {
    const events = completedTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      attempts: [
        { provider: 'self', model: 'model-a', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { provider: 'self', model: 'model-b', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
      ],
    })
    const aggregate = aggregateSessionEvents(events)
    expect(Object.keys(aggregate.byModel)).toHaveLength(0)
    expect(aggregate.unattributed).toMatchObject({ uncachedInput: 30, output: 13, requests: 2 })
    expect(aggregate.unattributedTurns).toBe(1)
    // 守恒：byDay 各桶 = byModel 各行 + unattributed
    expect(aggregate.byDay[DAY]).toMatchObject({ uncachedInput: 30, output: 13, requests: 2, turns: 1 })
  })

  it('retry：失败尝试无归因，整 turn（含成功账目）进 unattributed', () => {
    const events = retryTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      failedUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, totalTokens: 1050 },
      provider: 'self', model: 'deepseek-v4-flash',
    })
    const aggregate = aggregateSessionEvents(events)
    expect(aggregate.turns).toBe(1)
    expect(Object.keys(aggregate.byModel)).toHaveLength(0)
    // 失败 attempt 未报缓存桶 → turn 级缓存桶整体不披露（上游 every 语义）。
    expect(aggregate.unattributed).toMatchObject({ uncachedInput: 110, cacheRead: 0, output: 55, requests: 1 })
    expect(aggregate.unattributedTurns).toBe(1)
  })

  it('usage 为空对象的 message：量不猜，消息计数照记', () => {
    const events = completedTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      attempts: [{ usage: {} }],
    })
    const aggregate = aggregateSessionEvents(events)
    expect(aggregate.turns).toBe(1)
    expect(aggregate.unattributed.requests).toBe(1)
    expect(aggregate.byDay[DAY]?.turns).toBe(1)
  })

  it('跨天归属按 turn/end 的本地日期', () => {
    const nextDay = localMs(2026, 9, 6, 0, 30)
    const events = [
      ...completedTurn({ turn: 1, start: T0, end: T0 + 60_000, attempts: [{ usage: { inputTokens: 1, outputTokens: 1 } }] }),
      ...completedTurn({ turn: 2, start: nextDay - 60_000, end: nextDay, attempts: [{ usage: { inputTokens: 2, outputTokens: 2 } }] }),
    ]
    const aggregate = aggregateSessionEvents(events)
    expect(Object.keys(aggregate.byDay).toSorted()).toEqual(['2026-09-05', '2026-09-06'])
    expect(aggregate.byDay['2026-09-05']?.turns).toBe(1)
    expect(aggregate.byDay['2026-09-06']?.turns).toBe(1)
  })

  it('未闭合 turn（无 turn/end）不折算', () => {
    const events = [
      ev('turn/start', T0, { turn: 1 }),
      ev('step/start', T0, { turn: 1, step: 1 }),
      ev('assistant/message', T0, {
        turn: 1, step: 1,
        message: { source: { kind: 'model', provider: 'self', model: 'm' } },
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ]
    const aggregate = aggregateSessionEvents(events)
    expect(aggregate.turns).toBe(0)
    expect(Object.keys(aggregate.byDay)).toHaveLength(0)
    expect(Object.keys(aggregate.byModel)).toHaveLength(0)
  })

  it('turn 边界外事件忽略；空日志零聚合', () => {
    expect(aggregateSessionEvents([]).turns).toBe(0)
    const stray = aggregateSessionEvents([
      ev('assistant/message', T0, {
        turn: 1, step: 1,
        message: { source: { kind: 'model', provider: 'self', model: 'm' } },
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ])
    expect(stray.turns).toBe(0)
    expect(stray.firstActive).toBe(T0)
  })
})

describe('foldSessionRows', () => {
  const today = '2026-09-06'

  function dayRow(day: string, total: number): SessionUsageRowView {
    const aggregate = aggregateSessionEvents(completedTurn({
      turn: 1, start: localMs(2026, 9, 5), end: localMs(2026, 9, 5) + 1000,
      attempts: [{ usage: { inputTokens: total, outputTokens: 0 } }],
    }))
    // 用指定 day 覆盖（completedTurn 固定落在 start 当日，跨日场景直接改键）。
    const byDay = { [day]: aggregate.byDay[DAY]! }
    const byModel = Object.fromEntries(Object.entries(aggregate.byModel).map(([key, bucket]) => [
      key, { ...bucket, perDay: { [day]: bucket.perDay[DAY]! } },
    ]))
    return rowOf('s', { ...aggregate, byDay, byModel })
  }

  it('空行集：零汇总、无 streak', () => {
    const summary = foldSessionRows([], localMs(2026, 9, 6))
    expect(summary.byDay).toEqual([])
    expect(summary.byModel).toEqual([])
    expect(summary.overall.firstDay).toBeUndefined()
    expect(summary.overall.currentStreak).toBe(0)
    expect(summary.overall.longestStreak).toBe(0)
  })

  it('合并多行：会话数/子代理数/活跃跨度/按日与按模型折叠/排序', () => {
    const first = aggregateSessionEvents(completedTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      attempts: [{ usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, totalTokens: 1050 } }],
    }))
    const second = aggregateSessionEvents(completedTurn({
      turn: 1, start: localMs(2026, 9, 6, 9), end: localMs(2026, 9, 6, 9) + 30_000,
      attempts: [{ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
    }))
    const other = aggregateSessionEvents(completedTurn({
      turn: 1, start: localMs(2026, 9, 6, 9, 30), end: localMs(2026, 9, 6, 9, 30) + 10_000,
      attempts: [{ provider: 'self-completions', model: 'glm-5.3', usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 } }],
    }))
    const sub = aggregateSessionEvents(completedTurn({
      turn: 1, start: localMs(2026, 9, 6, 10), end: localMs(2026, 9, 6, 10) + 5000,
      attempts: [{ provider: 'self', model: 'deepseek-v4-flash', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }],
    }))
    const summary = foldSessionRows([
      rowOf('a', first),
      rowOf('b', second),
      rowOf('d', other),
      rowOf('c', sub, { isSubagent: true }),
    ], localMs(2026, 9, 6, 12))

    expect(summary.overall.sessions).toBe(4)
    expect(summary.overall.subagentSessions).toBe(1)
    expect(summary.overall.turns).toBe(4)
    expect(summary.overall.activeMs).toBe(60_000 + 30_000 + 10_000 + 5000)
    expect(summary.overall.firstDay).toBe(DAY)
    expect(summary.overall.lastDay).toBe(today)

    const totalA = 100 + 900 + 50
    expect(summary.overall.peakDay).toBe(DAY)
    expect(summary.overall.peakTokens).toBe(totalA)

    // 按用量降序：deepseek 1070 最大。
    expect(summary.byModel[0]?.model).toBe('deepseek-v4-flash')
    expect(summary.byModel[0]?.sessions).toBe(3)
    expect(summary.byModel[0]?.perDay[DAY]).toBe(totalA)
    expect(summary.byModel[0]?.perDay[today]).toBe(7 + 3 + 15)
    expect(summary.byModel.map(row => row.model)).toEqual(['deepseek-v4-flash', 'glm-5.3'])
    expect(summary.byModel[1]?.provider).toBe('self-completions')

    expect(summary.byDay).toHaveLength(2)
    expect(summary.byDay[1]?.turns).toBe(3)
    // 每日活跃会话数：DAY 只有会话 a；today 有 b/d/c 三个。
    expect(summary.byDay[0]?.sessions).toBe(1)
    expect(summary.byDay[1]?.sessions).toBe(3)
  })

  it('连续天数：今天收尾计 current，最长段跨月边界', () => {
    // 8-31、9-1、9-2 与 9-5、9-6（今天 9-6）：最长 3，当前 2。
    const rows = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-05', today].map(day => dayRow(day, 10))
    const summary = foldSessionRows(rows, localMs(2026, 9, 6, 12))
    expect(summary.overall.longestStreak).toBe(3)
    expect(summary.overall.currentStreak).toBe(2)
  })

  it('今天未活跃但昨天活跃：current 从昨天起算；断档则 0', () => {
    const yesterday = foldSessionRows([dayRow('2026-09-05', 10)], localMs(2026, 9, 6, 12))
    expect(yesterday.overall.currentStreak).toBe(1)

    const stale = foldSessionRows([dayRow('2026-09-01', 10)], localMs(2026, 9, 6, 12))
    expect(stale.overall.currentStreak).toBe(0)
  })

  it('unattributed 跨行累加，且与 byDay 总量守恒', () => {
    const aggregate = aggregateSessionEvents(completedTurn({
      turn: 1, start: T0, end: T0 + 60_000,
      attempts: [
        { provider: 'a', model: 'm1', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { provider: 'a', model: 'm2', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
      ],
    }))
    const summary = foldSessionRows([rowOf('a', aggregate)], localMs(2026, 9, 6))
    expect(summary.unattributed).toMatchObject({ uncachedInput: 30, output: 13 })
    const dayTotal = summary.byDay.reduce((sum, row) => sum + bucketTotal(row), 0)
    const modelTotal = summary.byModel.reduce((sum, row) => sum + bucketTotal(row.buckets), 0)
    expect(modelTotal + bucketTotal(summary.unattributed)).toBe(dayTotal)
  })
})
