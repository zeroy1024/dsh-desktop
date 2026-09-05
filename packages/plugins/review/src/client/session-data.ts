/** Consume the resident Session journal; the controller owns paging and reconnects. */
import type { HistoryPageLite, SessionEventLite } from './api.ts'

export interface EventWindow {
  entries: readonly { type: string; event: SessionEventLite }[]
  hasMore: boolean
  change?: { kind: string; entries: readonly { type: string; event: SessionEventLite }[] }
}
export interface ResidentSession {
  readonly historyStartSeq: number | undefined
  eventSource: { getSnapshot(): EventWindow; subscribe(listener: () => void): () => void }
  getSnapshot(): { loadingOlder: boolean }
  subscribe(listener: () => void): () => void
  loadOlder(): Promise<void>
  prompt(content: { type: 'text'; text: string }[], mode: 'queue'): Promise<{ ok: boolean }>
}
export interface SessionData {
  history(beforeSeq?: number, signal?: AbortSignal): Promise<HistoryPageLite>
  subscribe(listener: () => void): () => void
  send(text: string): Promise<void>
}

/** A competing Chat/Trajectory pager owns loadOlder until its busy flag clears. */
function waitForPaging(session: ResidentSession, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!session.getSnapshot().loadingOlder) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined
    const finish = (): void => {
      off?.()
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => { finish(); reject(signal?.reason) }
    const check = (): void => {
      if (session.getSnapshot().loadingOlder) return
      finish()
      resolve()
    }
    off = session.subscribe(check)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else check()
  })
}

export function sessionData(session: ResidentSession): SessionData {
  let paging = 0
  return {
    async history(beforeSeq, signal) {
      signal?.throwIfAborted()
      let window = session.eventSource.getSnapshot()
      if (beforeSeq !== undefined && window.hasMore) {
        paging += 1
        try {
          await waitForPaging(session, signal)
          signal?.throwIfAborted()
          window = session.eventSource.getSnapshot()
          if (window.hasMore && (session.historyStartSeq === undefined || session.historyStartSeq >= beforeSeq)) {
            await session.loadOlder()
            signal?.throwIfAborted()
            await waitForPaging(session, signal)
            window = session.eventSource.getSnapshot()
          }
          // loadOlder resolves on Remote failure. An unchanged cursor with
          // hasMore is an incomplete read, never evidence of an empty history.
          if (window.hasMore && (session.historyStartSeq === undefined || session.historyStartSeq >= beforeSeq)) {
            throw new Error('review: older history did not advance; retry the read')
          }
        } finally { paging -= 1 }
      }
      return {
        events: window.entries.filter(row => beforeSeq === undefined || row.event.seq < beforeSeq),
        hasMore: window.hasMore,
        ...(session.historyStartSeq === undefined ? {} : { nextBeforeSeq: session.historyStartSeq }),
      }
    },
    subscribe: listener => session.eventSource.subscribe(() => {
      // Paging publications are consumed by the in-flight history read itself.
      if (paging > 0) return
      const change = session.eventSource.getSnapshot().change
      // Token chunks do not change file edits. Replacements (rewind/reconnect)
      // do, even when their event window contains no tool result.
      if (change?.kind === 'append' && !change.entries.some(row =>
        row.type === 'event' && (row.event.type === 'tool/call'
          || row.event.type === 'tool/result' || row.event.type === 'dsh-desktop/session-rewind'))) return
      listener()
    }),
    async send(text) {
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      if (!result.ok) throw new Error('review: prompt was rejected')
    },
  }
}
