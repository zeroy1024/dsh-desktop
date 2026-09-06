/**
 * 数据面单测：parseSessionLog 容错、computeSummary 的缓存增量语义、
 * summary 路由的 HTTP 行为（405/403/200/500）。持久化与缓存表用内存 double。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { computeSummary, handleSummaryRequest, parseSessionLog, type UsagePersistence } from '../src/index.ts'
import { USAGE_FOLD_VERSION, usageStatsDomainSpec, type CachedUsageRow, type UsageTablePort } from '../src/usage-cache.ts'

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

/** 首行 header record + 事件行（header 无 type 字段，聚合层天然过滤）。 */
function jsonlOf(id: string, events: unknown[]): string {
  const header = JSON.stringify({ version: 0, id, createdAt: 1000 })
  return [header, ...events.map(event => JSON.stringify(event))].join('\n') + '\n'
}

interface FakeSession {
  header?: Record<string, unknown>
  events: unknown[]
  /** 模拟文件变化：revision 与缓存行不一致即触发重扫。 */
  revision?: string
  /** readRaw 抛错（损坏日志）。 */
  fail?: boolean
}

function fakePersistence(sessions: Record<string, FakeSession>) {
  const readRawCalls: string[] = []
  const persistence = {
    listSnapshots: async () => Object.entries(sessions).map(([id, session]) => ({
      header: { version: 0, id, createdAt: 1000, isSeeded: false, ...session.header },
      revision: session.revision ?? `${id}@0`,
    })),
    readRaw: async (id: string) => {
      const session = sessions[id]
      if (session === undefined) return undefined
      if (session.fail === true) throw new Error('corrupt log')
      readRawCalls.push(id)
      return {
        meta: { version: 0, id, createdAt: 1000, isSeeded: false },
        inheritedEventCount: 0,
        filename: 'session.jsonl',
        content: jsonlOf(id, session.events),
      }
    },
  }
  return { persistence: persistence as unknown as UsagePersistence & SessionPersistence, readRawCalls }
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

describe('parseSessionLog', () => {
  it('过滤 header 行与空行，解析事件行，跳过损坏行', () => {
    const content = [
      JSON.stringify({ version: 0, id: 's', createdAt: 1 }),
      '',
      JSON.stringify({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }),
      '{broken',
      JSON.stringify({ seq: 3, time: 3 }),
    ].join('\n')
    const events = parseSessionLog(content)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn/start' })
  })
})

describe('computeSummary', () => {
  it('空会话集：零汇总', async () => {
    const { persistence } = fakePersistence({})
    const { summary, meta } = await computeSummary(persistence, undefined, NOW)
    expect(meta).toEqual({ total: 0, scanned: 0, cached: 0 })
    expect(summary.byDay).toEqual([])
    expect(summary.overall.sessions).toBe(0)
  })

  it('新会话全量重折并写缓存；二次调用 revision 未变则命中缓存', async () => {
    const { persistence, readRawCalls } = fakePersistence({
      'session-a': { events: turnEvents(1, 1_788_000_000_000, 100) },
    })
    const table = fakeTable()
    const first = await computeSummary(persistence, table, NOW)
    expect(first.meta).toEqual({ total: 1, scanned: 1, cached: 0 })
    expect(first.summary.byModel[0]).toMatchObject({ provider: 'self', model: 'deepseek-v4-flash' })
    expect(table.map.size).toBe(1)
    expect([...table.map.values()][0]?.algoVersion).toBe(USAGE_FOLD_VERSION)

    const second = await computeSummary(persistence, table, NOW)
    expect(second.meta).toEqual({ total: 1, scanned: 0, cached: 1 })
    expect(second.summary.overall.sessions).toBe(1)
    expect(readRawCalls).toHaveLength(1)
  })

  it('revision 变化触发该会话重扫；删除的会话缓存行被清理', async () => {
    const sessions: Record<string, FakeSession> = {
      'session-a': { events: turnEvents(1, 1_788_000_000_000, 100), revision: 'a@1' },
      'session-b': { events: turnEvents(1, 1_788_000_000_000, 50), revision: 'b@1' },
    }
    const { persistence, readRawCalls } = fakePersistence(sessions)
    const table = fakeTable()
    await computeSummary(persistence, table, NOW)
    expect(table.map.size).toBe(2)

    sessions['session-a'].revision = 'a@2'
    delete sessions['session-b']
    const next = await computeSummary(persistence, table, NOW)
    expect(next.meta).toEqual({ total: 1, scanned: 1, cached: 0 })
    expect([...table.map.keys()]).toEqual(['session-a'])
    expect(readRawCalls).toEqual(['session-a', 'session-b', 'session-a'])
  })

  it('损坏会话降级跳过，不影响其余会话汇总', async () => {
    const { persistence } = fakePersistence({
      'session-bad': { events: [], fail: true },
      'session-good': { events: turnEvents(1, 1_788_000_000_000, 100) },
    })
    const { summary, meta } = await computeSummary(persistence, fakeTable(), NOW)
    expect(meta).toEqual({ total: 2, scanned: 2, cached: 0 })
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

/** 把 handleSummaryRequest 挂到真 http server 上，返回 base URL。 */
async function startServer(persistence: UsagePersistence, getPort: () => UsageTablePort | undefined): Promise<{
  base: string
  close: () => Promise<void>
}> {
  const server: Server = createServer((req, res) => {
    void handleSummaryRequest(req, res, persistence, getPort)
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

const servers: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(servers.map(server => server.close()))
})

describe('summary route', () => {
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
    expect(body).toMatchObject({ ok: true, total: 1, scanned: 1, cached: 0 })
    expect((body.summary as Record<string, unknown>).overall).toMatchObject({ sessions: 1 })
  })

  it('405 非 POST、403 异源，且不触发任何读日志', async () => {
    const { persistence, readRawCalls } = fakePersistence({
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
    expect(readRawCalls).toHaveLength(0)
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
