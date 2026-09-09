/**
 * 数据面单测：computeSummary 的缓存增量语义、
 * summary 路由的 HTTP 行为（405/403/200/500）。持久化与缓存表用内存 double。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  apply, CACHE_FAILURE_BACKOFF_MS, computeSummary, handleSummaryRequest,
  type UsagePersistence, type UsageStatsHostContext,
} from '../src/index.ts'
import { USAGE_FOLD_VERSION, cachedUsageRowSchema, usageStatsDomainSpec, type CachedUsageRow, type UsageTablePort } from '../src/usage-cache.ts'

/** 确认域声明本身通过上游 UNIT_NAME_RE 校验（defineDomain 在构造期校验）。 */
expect(usageStatsDomainSpec.name).toBe('usage_stats')

/** 最小合法 turn 的 JSONL 事件（形状对照上游 attempt 状态机）。 */
function turnEvents(turn: number, time: number, inputTokens: number, provider = 'self', model = 'deepseek-v4-flash'): unknown[] {
  return [
    { type: 'turn/start', seq: 1, time, data: { turn } },
    { type: 'step/start', seq: 2, time, data: { turn, step: 1 } },
    {
      type: 'assistant/message', seq: 3, time,
      data: {
        turn, step: 1,
        message: { source: { kind: 'model', provider, model } },
        usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
      },
    },
    { type: 'step/end', seq: 4, time, data: { turn, step: 1 } },
    { type: 'turn/end', seq: 5, time, data: { turn, reason: { kind: 'completed' } } },
  ]
}

interface FakeSession {
  header?: Record<string, unknown>
  inheritedEventCount?: number
  events: unknown[]
  /** 模拟文件变化：revision 与缓存行不一致即触发重扫。 */
  revision?: string
  /** readFrom 抛错（损坏日志）。 */
  fail?: boolean
  /** 模拟 list 与 read 之间的删除竞态：快照枚举可见，读日志时已删除。 */
  deletedBeforeRead?: boolean
}

function fakePersistence(sessions: Record<string, FakeSession>) {
  const readFromCalls: string[] = []
  const persistence = {
    listSnapshots: async () => Object.entries(sessions).map(([id, session]) => ({
      header: { version: 0, id, createdAt: 1000, isSeeded: false, ...session.header },
      revision: session.revision ?? `${id}@0`,
    })),
    readFrom: async (id: string) => {
      const session = sessions[id]
      // 与真实契约一致：缺失会话抛 SessionPersistenceNotFoundError，而非返回 undefined。
      if (session === undefined || session.deletedBeforeRead === true) {
        throw new SessionPersistenceNotFoundError(SessionId(id))
      }
      if (session.fail === true) throw new Error('corrupt log')
      readFromCalls.push(id)
      return {
        meta: { version: 0, id, createdAt: 1000, isSeeded: false, ...session.header },
        inheritedEventCount: session.inheritedEventCount ?? 0,
        fromSeq: 0,
        events: session.events,
      }
    },
  }
  return { persistence: persistence as unknown as UsagePersistence & SessionPersistence, readFromCalls }
}

function fakeTable(): UsageTablePort & { map: Map<string, CachedUsageRow> } {
  const map = new Map<string, CachedUsageRow>()
  return {
    map,
    get: key => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value) },
    delete: async key => map.delete(key),
  }
}

const NOW = 1_788_000_000_000

describe('computeSummary', () => {
  it('空会话集：零汇总', async () => {
    const { persistence } = fakePersistence({})
    const { summary, meta } = await computeSummary(persistence, undefined, NOW)
    expect(meta).toEqual({ total: 0, scanned: 0, cached: 0, failed: 0 })
    expect(summary.byDay).toEqual([])
    expect(summary.overall.sessions).toBe(0)
  })

  it('新会话全量重折并写缓存；二次调用 revision 未变则命中缓存', async () => {
    const { persistence, readFromCalls } = fakePersistence({
      'session-a': { events: turnEvents(1, 1_788_000_000_000, 100) },
    })
    const table = fakeTable()
    const first = await computeSummary(persistence, table, NOW)
    expect(first.meta).toEqual({ total: 1, scanned: 1, cached: 0, failed: 0 })
    expect(first.summary.byModel[0]).toMatchObject({ provider: 'self', model: 'deepseek-v4-flash' })
    expect(table.map.size).toBe(1)
    expect([...table.map.values()][0]?.algoVersion).toBe(USAGE_FOLD_VERSION)

    const second = await computeSummary(persistence, table, NOW)
    expect(second.meta).toEqual({ total: 1, scanned: 0, cached: 1, failed: 0 })
    expect(second.summary.overall.sessions).toBe(1)
    expect(readFromCalls).toHaveLength(1)
  })

  it('revision 变化触发该会话重扫；删除的会话缓存行被清理', async () => {
    const sessions: Record<string, FakeSession> = {
      'session-a': { events: turnEvents(1, 1_788_000_000_000, 100), revision: 'a@1' },
      'session-b': { events: turnEvents(1, 1_788_000_000_000, 50), revision: 'b@1' },
    }
    const { persistence, readFromCalls } = fakePersistence(sessions)
    const table = fakeTable()
    await computeSummary(persistence, table, NOW)
    expect(table.map.size).toBe(2)

    sessions['session-a'].revision = 'a@2'
    delete sessions['session-b']
    const next = await computeSummary(persistence, table, NOW)
    expect(next.meta).toEqual({ total: 1, scanned: 1, cached: 0, failed: 0 })
    expect([...table.map.keys()]).toEqual(['session-a'])
    expect(readFromCalls).toEqual(['session-a', 'session-b', 'session-a'])
  })

  it('损坏会话降级跳过，不影响其余会话汇总', async () => {
    const { persistence } = fakePersistence({
      'session-bad': { events: [], fail: true },
      'session-good': { events: turnEvents(1, 1_788_000_000_000, 100) },
    })
    const { summary, meta } = await computeSummary(persistence, fakeTable(), NOW)
    expect(meta).toEqual({ total: 2, scanned: 2, cached: 0, failed: 1 })
    expect(summary.overall.sessions).toBe(1)
    expect(summary.overall.turns).toBe(1)
  })

  it('list 与 read 之间被删除的会话静默跳过：不计 failed，其余会话正常统计', async () => {
    const { persistence } = fakePersistence({
      'session-deleted': { events: [], deletedBeforeRead: true },
      'session-good': { events: turnEvents(1, 1_788_000_000_000, 100) },
    })
    const { summary, meta } = await computeSummary(persistence, fakeTable(), NOW)
    expect(meta).toEqual({ total: 2, scanned: 2, cached: 0, failed: 0 })
    expect(summary.overall.sessions).toBe(1)
    expect(summary.overall.turns).toBe(1)
  })

  it('缺 totalTokens 的旧日志与空 trailing step 仍计入四桶', async () => {
    const time = 1_788_000_000_000
    const { persistence } = fakePersistence({
      'session-old': {
        events: [
          { type: 'turn/start', seq: 1, time, data: { turn: 1 } },
          { type: 'step/start', seq: 2, time, data: { turn: 1, step: 1 } },
          {
            type: 'assistant/message', seq: 3, time,
            data: {
              turn: 1, step: 1,
              message: { source: { kind: 'model', provider: 'self', model: 'qwen' } },
              usage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 900 },
            },
          },
          { type: 'step/end', seq: 4, time, data: { turn: 1, step: 1 } },
          { type: 'step/start', seq: 5, time, data: { turn: 1, step: 2 } },
          { type: 'step/end', seq: 6, time, data: { turn: 1, step: 2 } },
          { type: 'turn/end', seq: 7, time, data: { turn: 1, reason: { kind: 'completed' } } },
        ],
      },
    })
    const { summary } = await computeSummary(persistence, fakeTable(), NOW)
    expect(summary.byModel[0]).toMatchObject({ provider: 'self', model: 'qwen' })
    expect(summary.byModel[0]?.buckets).toMatchObject({
      uncachedInput: 100, cacheRead: 900, cacheWrite: 0, output: 2, requests: 1,
    })
    expect(summary.overall.turns).toBe(1)
  })

  it('子代理会话按 header 标记归类', async () => {
    const { persistence } = fakePersistence({
      'session-sub': {
        header: { origin: 'subagent', parentSession: 'session-parent' },
        events: turnEvents(1, 1_788_000_000_000, 100),
      },
    })
    const { summary } = await computeSummary(persistence, fakeTable(), NOW)
    expect(summary.overall.subagentSessions).toBe(1)
  })
})

/** 把路由 handler 挂到真 http server 上，返回 base URL。 */
async function startHandlerServer(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<{
  base: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

/** 把 handleSummaryRequest 挂到真 http server 上，返回 base URL。 */
async function startServer(persistence: UsagePersistence, getPort: () => UsageTablePort | undefined) {
  return startHandlerServer((req, res) => handleSummaryRequest(req, res, persistence, getPort))
}

const servers: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(servers.map(server => server.close()))
})

describe('summary route', () => {
  it('reports incomplete totals when every source log fails', async () => {
    const { persistence } = fakePersistence({ bad: { events: [], fail: true } })
    const server = await startServer(persistence, () => undefined)
    servers.push(server)
    const response = await fetch(`${server.base}/dsh-desktop/usage/summary`, {
      method: 'POST', headers: { origin: server.base },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true, total: 1, failed: 1, summary: { overall: { sessions: 0 } },
    })
  })

  it('200：认证同源请求返回汇总信封', async () => {
    const { persistence } = fakePersistence({
      'session-a': { events: turnEvents(1, 1_788_000_000_000, 100) },
    })
    const table = fakeTable()
    const server = await startServer(persistence, () => table)
    servers.push(server)

    const response = await fetch(`${server.base}/dsh-desktop/usage/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{}',
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, total: 1, scanned: 1, cached: 0, failed: 0 })
    expect((body.summary as Record<string, unknown>).overall).toMatchObject({ sessions: 1 })
  })

  it('405 非 POST、403 异源，且不触发任何读日志', async () => {
    const { persistence, readFromCalls } = fakePersistence({
      'session-a': { events: [] },
    })
    const server = await startServer(persistence, () => undefined)
    servers.push(server)

    const method = await fetch(`${server.base}/dsh-desktop/usage/summary`)
    expect(method.status).toBe(405)

    const foreign = await fetch(`${server.base}/dsh-desktop/usage/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9999' },
      body: '{}',
    })
    expect(foreign.status).toBe(403)
    expect(readFromCalls).toHaveLength(0)
  })

  it('500：持久化故障返回结构化错误信封', async () => {
    const broken = {
      listSnapshots: async () => { throw new Error('storage unavailable') },
    } as unknown as UsagePersistence
    const server = await startServer(broken, () => undefined)
    servers.push(server)

    const response = await fetch(`${server.base}/dsh-desktop/usage/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{}',
    })
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'internal-error' })
  })
})


describe('usage cache and lineage regressions', () => {
  it('retains billed calls hidden by rewind and counts an open retry attempt', async () => {
    const events = [
      ...turnEvents(1, NOW, 99),
      { type: 'dsh-desktop/session-rewind', seq: 6, time: NOW, data: { atSeq: 1 } },
      { type: 'turn/start', seq: 7, time: NOW, data: { turn: 2 } },
      { type: 'assistant/chunk', seq: 8, time: NOW, data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } } } },
      { type: 'llm/retry-started', seq: 9, time: NOW, data: { turn: 2, step: 1 } },
      { type: 'assistant/chunk', seq: 10, time: NOW, data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 19, outputTokens: 1 } } } },
    ]
    const { persistence } = fakePersistence({ a: { events } })
    const { summary } = await computeSummary(persistence, undefined, NOW)
    expect(summary.byModel[0]?.buckets).toMatchObject({ uncachedInput: 99, output: 1 })
    expect(summary.unattributed).toMatchObject({ uncachedInput: 28, output: 2 })
    expect(summary.overall.turns).toBe(2)
  })

  it('counts own calls once across multiple forks and keeps ordinary forks out of subagent counts', async () => {
    const parent = turnEvents(1, NOW, 109).map((event, seq) => ({ ...(event as object), seq }))
    const own = turnEvents(2, NOW, 19).map((event, index) => ({ ...(event as object), seq: parent.length + index }))
    const { persistence } = fakePersistence({
      parent: { events: parent },
      child: { header: { parentSession: 'parent', isSeeded: true }, inheritedEventCount: parent.length, events: [...parent, ...own] },
      grandchild: { header: { parentSession: 'child', isSeeded: true }, inheritedEventCount: parent.length + own.length, events: [...parent, ...own] },
    })
    const { summary } = await computeSummary(persistence, undefined, NOW)
    expect(summary.byModel[0]?.buckets).toMatchObject({ uncachedInput: 128, output: 2, requests: 2 })
    expect(summary.overall).toMatchObject({ turns: 2, subagentSessions: 0 })
  })

  it.each(['get', 'put', 'delete', 'entries'] as const)('isolates cache %s failures and retries on the next request', async operation => {
    const sessions = { a: { events: turnEvents(1, NOW, 100) }, b: { events: turnEvents(1, NOW, 50) } }
    const { persistence } = fakePersistence(sessions)
    const expected = await computeSummary(persistence, undefined, NOW)
    const table = fakeTable()
    await computeSummary(persistence, table, NOW)
    table.map.set('obsolete', table.map.get('a')!)
    table.map.delete('a')
    table.map.delete('b')
    const original = table[operation]
    let attempts = 0
    Object.assign(table, { [operation]: () => { attempts++; throw new Error('cache unavailable') } })
    const actual = await computeSummary(persistence, table, NOW)
    expect(actual.summary).toEqual(expected.summary)
    expect(actual.meta.failed).toBe(0)
    expect(attempts).toBe(1)
    Object.assign(table, { [operation]: original })
    await computeSummary(persistence, table, NOW)
    expect(table.map.has('a')).toBe(true)
  })

  it('单条过期缓存行删除失败不中止其余过期 key 的清扫', async () => {
    const { persistence } = fakePersistence({ a: { events: turnEvents(1, NOW, 100) } })
    const table = fakeTable()
    await computeSummary(persistence, table, NOW)
    const staleRow = table.map.get('a')!
    // Map 迭代按插入序：stale-1 在前、其删除抛错；粗粒度 try 会中止 stale-2 的清扫。
    table.map.set('stale-1', staleRow)
    table.map.set('stale-2', staleRow)
    const originalDelete = table.delete
    Object.assign(table, {
      delete: async (key: string) => {
        if (key === 'stale-1') throw new Error('delete blocked')
        return originalDelete(key)
      },
    })
    const { meta } = await computeSummary(persistence, table, NOW)
    expect(meta).toEqual({ total: 1, scanned: 0, cached: 1, failed: 0 })
    expect(table.map.has('stale-1')).toBe(true)
    expect(table.map.has('stale-2')).toBe(false)
    expect(table.map.has('a')).toBe(true)
  })

  it('accepts an old cache row as valid data but replaces it without a revision change', async () => {
    const { persistence, readFromCalls } = fakePersistence({ a: { events: turnEvents(1, NOW, 100) } })
    const table = fakeTable()
    await computeSummary(persistence, table, NOW)
    const old = { ...table.map.get('a')!, algoVersion: 1 }
    expect(cachedUsageRowSchema.safeParse(old).success).toBe(true)
    table.map.set('a', old)
    await computeSummary(persistence, table, NOW)
    expect(readFromCalls).toHaveLength(2)
    expect(table.map.get('a')?.algoVersion).toBe(USAGE_FOLD_VERSION)
  })
})


describe('cache failure backoff', () => {
  it('缓存失败后进入退避窗口：窗口内跳过缓存层，窗口过后恢复', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const { persistence } = fakePersistence({ a: { events: turnEvents(1, NOW, 100) } })
      const table = fakeTable()
      let cacheOps = 0
      let entriesHealthy = false
      // 确定性故障：entries 恒抛错（磁盘只读类），故障恢复前缓存层不可用。
      const failingPort: UsageTablePort = {
        get: key => { cacheOps++; return table.get(key) },
        entries: () => {
          cacheOps++
          if (!entriesHealthy) throw new Error('read-only store')
          return table.entries()
        },
        put: async (key, value) => { cacheOps++; await table.put(key, value) },
        delete: async key => { cacheOps++; return table.delete(key) },
      }
      // 驱动完整 apply：捕获注册的路由 handler 与缓存域 effect。
      let routeHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
      const effects: Array<Promise<unknown>> = []
      const ctx = {
        effect: (fn: () => unknown) => {
          effects.push(Promise.resolve().then(() => fn()))
          return async () => {}
        },
        webServer: {
          register: (route: { handler: NonNullable<typeof routeHandler> }) => {
            routeHandler = route.handler
            return async () => {}
          },
        },
        connection: { requestRejection: () => undefined },
        sessionPersistence: persistence,
        storageDomain: {
          open: async () => ({ table: () => failingPort, close: async () => {} }),
        },
      } as unknown as UsageStatsHostContext
      apply(ctx)
      await Promise.all(effects)
      const server = await startHandlerServer((req, res) => routeHandler!(req, res))
      servers.push(server)
      const post = () => fetch(`${server.base}/dsh-desktop/usage/summary`, {
        method: 'POST', headers: { origin: server.base },
      })

      // 第 1 次请求：entries 抛错 → 本次全量扫，同时进入退避窗口。
      const first = await post()
      await expect(first.json()).resolves.toMatchObject({ ok: true, total: 1, scanned: 1, failed: 0 })
      expect(cacheOps).toBe(1)

      // 窗口内第 2 次请求：不再触碰缓存层，直接全量扫。
      const second = await post()
      await expect(second.json()).resolves.toMatchObject({ ok: true, total: 1, scanned: 1, failed: 0 })
      expect(cacheOps).toBe(1)

      // 窗口过后且故障恢复：重新使用缓存层并写入聚合结果。
      entriesHealthy = true
      nowSpy.mockReturnValue(NOW + CACHE_FAILURE_BACKOFF_MS + 1)
      const third = await post()
      await expect(third.json()).resolves.toMatchObject({ ok: true, total: 1, scanned: 1, cached: 0, failed: 0 })
      expect(cacheOps).toBeGreaterThan(1)
      expect(table.map.has('a')).toBe(true)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
