import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import { sessionData, type EventWindow, type ResidentSession } from '../src/client/session-data.ts'
import { rewindHistoryFixture } from './rewind-history.fixture.ts'

const idlePager = { getSnapshot: () => ({ loadingOlder: false }), subscribe: () => () => {} }

const row = (seq: number) => ({ type: 'event', event: { type: 'user/message', seq, time: 1 } })
describe('0.1.2 resident Session journal', () => {
  it('pages through the owner and reads the visible window after rewind', async () => {
    let window: EventWindow = { entries: [row(5), row(6)], hasMore: true }
    const listeners = new Set<() => void>()
    const session = {
      ...idlePager,
      get historyStartSeq() { return window.entries[0]?.event.seq },
      eventSource: { getSnapshot: () => window, subscribe: (fn: () => void) => {
        listeners.add(fn); return () => { listeners.delete(fn) }
      } },
      loadOlder: vi.fn(async () => { window = { entries: [row(1), ...window.entries], hasMore: false } }),
      prompt: vi.fn(async () => ({ ok: true })),
    }
    const data = sessionData(session)
    expect((await data.history()).events.map(r => r.event.seq)).toEqual([5, 6])
    expect((await data.history(5)).events.map(r => r.event.seq)).toEqual([1])
    const changed = vi.fn()
    const off = data.subscribe(changed)
    window = { entries: [row(1), row(7)], hasMore: false }
    for (const fn of listeners) fn()
    expect(changed).toHaveBeenCalledOnce()
    expect((await data.history()).events.map(r => r.event.seq)).toEqual([1, 7])
    await data.send('review comment')
    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'review comment' }], 'queue')
    session.prompt.mockResolvedValueOnce({ ok: false })
    await expect(data.send('rejected')).rejects.toThrow('prompt was rejected')
    off()
    expect(listeners.size).toBe(0)
  })
})

it('keeps chunk-only pages traversable and ignores token-only live publications', async () => {
  const chunk = { type: 'chunks', event: { type: 'chunkrow/reasoning', seq: 50, time: 1 } }
  let window: EventWindow = { entries: [chunk], hasMore: true }
  let notify: () => void = vi.fn()
  const data = sessionData({
    ...idlePager,
    get historyStartSeq() { return window.entries[0]?.event.seq },
    eventSource: { getSnapshot: () => window, subscribe: fn => { notify = fn; return () => {} } },
    loadOlder: async () => { window = { entries: [row(1), chunk], hasMore: false } },
    prompt: async () => ({ ok: true }),
  })
  const tail = await data.history()
  expect(tail.events[0]?.event.seq).toBe(50)
  expect((await data.history(50)).events[0]?.event.seq).toBe(1)
  const changed = vi.fn()
  data.subscribe(changed)
  window = { ...window, change: { kind: 'append', entries: [chunk] } }
  notify()
  expect(changed).not.toHaveBeenCalled()
  window = { ...window, entries: [], change: { kind: 'replace', entries: [] } }
  notify()
  expect(changed).toHaveBeenCalledOnce()
})


it('keeps the local resident-session face assignable from the published Session type', () => {
  expectTypeOf<Session>().toExtend<ResidentSession>()
})

it('rejects a swallowed paging failure instead of calling the tail a complete history', async () => {
  const data = sessionData({
    ...idlePager,
    historyStartSeq: 50,
    eventSource: { getSnapshot: () => ({ entries: [row(50)], hasMore: true }), subscribe: () => () => {} },
    loadOlder: async () => {},
    prompt: async () => ({ ok: true }),
  })
  await expect(data.history(50)).rejects.toThrow('older history did not advance')
})

it('waits for a concurrent Chat pager and consumes its progress without a duplicate page request', async () => {
  let busy = true
  let window: EventWindow = { entries: [row(50)], hasMore: true }
  const listeners = new Set<() => void>()
  const loadOlder = vi.fn(async () => {})
  const data = sessionData({
    get historyStartSeq() { return window.entries[0]?.event.seq },
    getSnapshot: () => ({ loadingOlder: busy }),
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    eventSource: { getSnapshot: () => window, subscribe: () => () => {} },
    loadOlder,
    prompt: async () => ({ ok: true }),
  })
  const pending = data.history(50)
  expect(listeners.size).toBe(1)
  window = { entries: [row(20), row(50)], hasMore: true }
  busy = false
  for (const listener of listeners) listener()
  expect((await pending).events.map(entry => entry.event.seq)).toEqual([20])
  expect(loadOlder).not.toHaveBeenCalled()
  expect(listeners.size).toBe(0)
})

it('releases the busy-wait subscription when a hidden page aborts the read', async () => {
  const listeners = new Set<() => void>()
  const loadOlder = vi.fn(async () => {})
  const data = sessionData({
    historyStartSeq: 50,
    getSnapshot: () => ({ loadingOlder: true }),
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    eventSource: { getSnapshot: () => ({ entries: [row(50)], hasMore: true }), subscribe: () => () => {} },
    loadOlder,
    prompt: async () => ({ ok: true }),
  })
  const controller = new AbortController()
  const pending = data.history(50, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(listeners.size).toBe(0)
  expect(loadOlder).not.toHaveBeenCalled()
})

it('counts a fully withdrawn raw page as progress and continues to older visible edits', async () => {
  const fixture = rewindHistoryFixture()
  const data = sessionData(fixture.session)
  const hidden = await data.history(10)
  expect(hidden).toMatchObject({ events: [], hasMore: true, nextBeforeSeq: 7 })
  const older = await data.history(7)
  expect(older.events.map(entry => entry.event.seq)).toEqual([1, 2, 3, 4])
  expect(older.hasMore).toBe(false)
  fixture.dispose()
})

it('does not mistake concurrent streaming appends for successful history paging', async () => {
  let window: EventWindow = { entries: [row(50)], hasMore: true }
  const data = sessionData({
    ...idlePager, historyStartSeq: 50,
    eventSource: { getSnapshot: () => window, subscribe: () => () => {} },
    loadOlder: async () => {
      window = { entries: [row(50), row(51)], hasMore: true,
        change: { kind: 'append', entries: [row(51)] } }
    },
    prompt: async () => ({ ok: true }),
  })
  await expect(data.history(50)).rejects.toThrow('older history did not advance')
})
