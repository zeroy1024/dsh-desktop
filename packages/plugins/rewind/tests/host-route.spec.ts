import { createServer, type Server } from 'node:http'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { handleRewindRequest, isSameOrigin, precheckRewind, REWIND_EXECUTE_PATH } from '../src/index.ts'
import { REWIND_EVENT_TYPE } from '../src/shared.ts'

/** 模拟 live Session：events 快照 + append 记录。 */
function fakeSession(events: readonly SessionEvent[]) {
  return {
    events,
    append: vi.fn((type: string, data: unknown) => ({ type, data, seq: events.length })),
  }
}

function event(seq: number, patch: Record<string, unknown>): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, ...patch } as unknown as SessionEvent
}

function userEvent(seq: number): SessionEvent {
  return event(seq, { type: 'user/message', surfaceOp: 'append', data: { content: [] } })
}

function assistantEvent(seq: number): SessionEvent {
  return event(seq, { type: 'assistant/message', surfaceOp: 'append', data: {} })
}

async function startServer(
  sessions: { get: (id: string) => unknown },
  agents: { get: (id: string) => { status: string } | undefined },
): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void handleRewindRequest(req, res, sessions as never, agents as never)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => { server.close(() => resolve()) }),
  }
}

const servers: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(servers.map(server => server.close()))
})

describe('isSameOrigin', () => {
  it('accepts matching origin/host and rejects everything else', () => {
    expect(isSameOrigin('http://127.0.0.1:49152', '127.0.0.1:49152')).toBe(true)
    expect(isSameOrigin('http://localhost:49152', 'localhost:49152')).toBe(true)
    expect(isSameOrigin('http://[::1]:49152', '[::1]:49152')).toBe(true)
    expect(isSameOrigin(undefined, '127.0.0.1:1')).toBe(false)
    expect(isSameOrigin('http://127.0.0.1:9999', '127.0.0.1:1')).toBe(false)
  })

  it('rejects a rebinding-shaped request where Origin equals a non-loopback Host', () => {
    // DNS rebinding：攻击域解析到 127.0.0.1，Origin 与 Host 同为攻击域。
    expect(isSameOrigin('http://evil.example:8080', 'evil.example:8080')).toBe(false)
  })
})

describe('precheckRewind', () => {
  it('requires atSeq to address a user/message event', () => {
    const events = [userEvent(0), assistantEvent(1), userEvent(2)]
    expect(precheckRewind(events, 2)).toBeUndefined()
    expect(precheckRewind(events, 1)).toBe('invalid-at-seq')
    expect(precheckRewind(events, 99)).toBe('invalid-at-seq')
    expect(precheckRewind(events, -1)).toBe('invalid-at-seq')
    expect(precheckRewind(events, 1.5)).toBe('invalid-at-seq')
    expect(precheckRewind(events, '0')).toBe('invalid-at-seq')
  })

  it('refuses a range crossing a compaction replacement', () => {
    const events = [
      userEvent(0),
      assistantEvent(1),
      userEvent(2),
      assistantEvent(3),
      // 替换事件：起点 0，自身 seq 5 —— 撤回到 2 会把它连同覆盖的更早历史一起截掉。
      event(5, { type: 'user/message', surfaceOp: { op: 'replace', start: 0, end: 1 }, data: {} }),
    ]
    expect(precheckRewind(events, 2)).toBe('compaction-boundary')
    // 撤回点在替换段起点之前：区间不含替换节点，不受影响。
    expect(precheckRewind(events, 0)).toBeUndefined()
  })
})

describe('rewind execute route', () => {
  it('appends one tombstone to the live session', async () => {
    const session = fakeSession([userEvent(0), assistantEvent(1), userEvent(2)])
    const server = await startServer(
      { get: () => session },
      { get: () => undefined },
    )
    servers.push(server)

    const response = await fetch(`${server.base}${REWIND_EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: JSON.stringify({ sessionId: 'session-1', atSeq: 2 }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, atSeq: 2 })
    expect(session.append).toHaveBeenCalledWith(REWIND_EVENT_TYPE, { atSeq: 2 })
  })

  it('answers 409 for cold sessions and running agents without appending', async () => {
    const session = fakeSession([userEvent(0)])
    const server = await startServer(
      { get: (id: string) => (id === 'live' ? session : undefined) },
      { get: (id: string) => (id === 'live' ? { status: 'running' } : undefined) },
    )
    servers.push(server)

    const cold = await fetch(`${server.base}${REWIND_EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: JSON.stringify({ sessionId: 'cold', atSeq: 0 }),
    })
    expect(cold.status).toBe(409)
    await expect(cold.json()).resolves.toMatchObject({ ok: false, code: 'not-live' })

    const busy = await fetch(`${server.base}${REWIND_EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: JSON.stringify({ sessionId: 'live', atSeq: 0 }),
    })
    expect(busy.status).toBe(409)
    await expect(busy.json()).resolves.toMatchObject({ ok: false, code: 'agent-running' })
    expect(session.append).not.toHaveBeenCalled()
  })

  it('answers 405/403/400 for malformed requests', async () => {
    const server = await startServer({ get: () => undefined }, { get: () => undefined })
    servers.push(server)

    expect((await fetch(`${server.base}${REWIND_EXECUTE_PATH}`)).status).toBe(405)

    const foreign = await fetch(`${server.base}${REWIND_EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9' },
      body: JSON.stringify({ sessionId: 's', atSeq: 0 }),
    })
    expect(foreign.status).toBe(403)

    const badPayload = await fetch(`${server.base}${REWIND_EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: JSON.stringify({ atSeq: 0 }),
    })
    expect(badPayload.status).toBe(400)
  })
})
