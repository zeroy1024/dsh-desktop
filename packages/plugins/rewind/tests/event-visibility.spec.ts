import { describe, expect, it } from 'vitest'
import { createRewindVisibilitySource, type EventEntry, type EventSource, type EventWindow } from '../src/client/event-visibility.ts'

const event = (seq: number, type = 'assistant/chunk', data: unknown = {}): Extract<EventEntry, { type: 'event' }> => ({ type: 'event', event: { seq, type, data } })
function rawSource() {
  const listeners = new Set<() => void>()
  let window: EventWindow = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  return {
    getSnapshot: () => window,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next: EventWindow) { window = next; for (const listener of listeners) listener() },
    get listeners() { return listeners.size },
  } satisfies EventSource & { publish(next: EventWindow): void; readonly listeners: number }
}

describe('rewind event view', () => {
  it('forwards 10,000 ordinary deltas without reading the complete window', () => {
    const raw = rawSource()
    const view = createRewindVisibilitySource(raw)
    for (let seq = 0; seq < 10_000; seq++) {
      const delta = [event(seq)]
      const window: EventWindow = {
        get entries(): readonly EventEntry[] { throw new Error('streaming append materialized the full log') },
        hasMore: false, revision: seq + 1, change: { kind: 'append', entries: delta },
      }
      raw.publish(window)
      expect(view.source.getSnapshot()).toBe(window)
      expect(view.source.getSnapshot().change.entries).toBe(delta)
    }
    view.dispose()
    expect(raw.listeners).toBe(0)
  })

  it('filters historical pages and replaces the visible window on a live tombstone', () => {
    const raw = rawSource()
    const view = createRewindVisibilitySource(raw)
    const old = event(1, 'user/message')
    const withdrawn = event(10, 'user/message')
    raw.publish({ entries: [withdrawn], hasMore: true, revision: 1, change: { kind: 'replace', entries: [withdrawn] } })
    const marker = event(20, 'dsh-desktop/session-rewind', { atSeq: 10 })
    raw.publish({ entries: [withdrawn, marker], hasMore: true, revision: 2, change: { kind: 'append', entries: [marker] } })
    expect(view.source.getSnapshot().change.kind).toBe('replace')
    expect(view.source.getSnapshot().entries).toEqual([marker])
    const hiddenPage = event(11)
    raw.publish({ entries: [old, withdrawn, hiddenPage, marker], hasMore: false, revision: 3, change: { kind: 'prepend', entries: [old, hiddenPage] } })
    expect(view.source.getSnapshot().change.entries).toEqual([old])
    expect(view.source.getSnapshot().entries).toEqual([old, marker])
    const next = event(21)
    raw.publish({ entries: [old, withdrawn, hiddenPage, marker, next], hasMore: false, revision: 4, change: { kind: 'append', entries: [next] } })
    expect(view.source.getSnapshot().change).toEqual({ kind: 'append', entries: [next] })
    expect(view.source.getSnapshot().entries).toEqual([old, marker, next])
  })
})
