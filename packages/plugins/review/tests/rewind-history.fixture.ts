import { vi } from 'vitest'
import { createRewindVisibilitySource, type EventWindow } from '../../rewind/src/client/event-visibility.ts'
import type { ResidentSession } from '../src/client/session-data.ts'

const row = (seq: number, type = 'user/message', data: unknown = {}) => ({
  type: 'event' as const, event: { seq, time: seq, type, data },
})

/** A successful raw page can contain only events hidden by the real rewind view. */
export function rewindHistoryFixture() {
  const marker = row(20, 'dsh-desktop/session-rewind', { atSeq: 5 })
  let raw: EventWindow = {
    entries: [row(10), marker], hasMore: true, revision: 1,
    change: { kind: 'replace', entries: [row(10), marker] },
  }
  let cursor = 10
  let publish: () => void = vi.fn()
  const view = createRewindVisibilitySource({
    getSnapshot: () => raw,
    subscribe: listener => { publish = listener; return () => {} },
  })
  const loadOlder = vi.fn(async () => {
    const page = cursor === 10 ? [row(7), row(8), row(9)] : [row(1), row(2, 'tool/result', {
      meta: { diffs: [{ path: 'kept.ts', oldText: null, newText: 'kept' }] },
    }), row(3), row(4), row(5), row(6)]
    cursor = page[0]!.event.seq
    raw = { entries: [...page, ...raw.entries], hasMore: cursor > 1, revision: raw.revision + 1,
      change: { kind: 'prepend', entries: page } }
    publish()
  })
  return {
    session: {
      get historyStartSeq() { return cursor },
      // The view retains every raw event field; its minimal public shape omits time.
      eventSource: view.source as unknown as ResidentSession['eventSource'],
      getSnapshot: () => ({ loadingOlder: false }), subscribe: () => () => {},
      loadOlder, prompt: async () => ({ ok: true }),
    },
    dispose: view.dispose,
  }
}
