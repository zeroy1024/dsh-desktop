/** Resident Session events and generated Remote actions used by the file pane. */
import type { EnvelopeSource } from './api.ts'
import type { SessionOpenWorkspacePathRequest } from '@deepseek-ai/dsh-api-session-controller/types'

type Entry = { type: string; event: { seq: number; type: string; data?: unknown } }
export interface FileSession {
  eventSource: {
    getSnapshot(): { entries: readonly Entry[]; change?: { kind: string; entries: readonly Entry[] } }
    subscribe(listener: () => void): () => void
  }
}
export interface FileRemote {
  session: {
    openWorkspacePath(request: SessionOpenWorkspacePathRequest): Promise<{ ok: boolean }>
  }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'web_search', 'web_fetch'])

export function fileEvents(session: FileSession, sessionId: string): EnvelopeSource {
  return {
    subscribeEnvelopes(listener) {
      const calls = new Map<string, { name: string; path?: string }>()
      let lastSeq = -1
      const publish = (initial = false): void => {
        const window = session.eventSource.getSnapshot()
        const replace = window.change?.kind === 'replace'
        if (replace) { calls.clear(); lastSeq = -1 }
        // Appends carry their exact delta: do not rescan the entire transcript
        // on every token. A new subscription reconciles work done while hidden.
        const entries = !initial && window.change?.kind === 'append'
          ? window.change.entries : window.entries
        const paths = new Set<string>()
        for (const row of entries) {
          if (row.type !== 'event') continue
          const { event } = row
          if (event.seq <= lastSeq) continue
          const data = record(event.data)
          if (event.type === 'tool/call' && typeof data?.callId === 'string') {
            const call: { name: string; path?: string } = { name: typeof data.name === 'string' ? data.name : '' }
            try {
              const args = record(JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}'))
              const path = args?.file_path ?? args?.path
              if (typeof path === 'string') call.path = path
            } catch { /* incomplete arguments */ }
            calls.set(data.callId, call)
          }
          if (event.type !== 'tool/result') continue
          const callId = record(record(data?.message)?.source)?.callId
          const call = typeof callId === 'string' ? calls.get(callId) : undefined
          if (typeof callId === 'string') calls.delete(callId)
          let hasDiffPath = false
          const diffs = record(data?.meta)?.diffs
          if (Array.isArray(diffs)) for (const diff of diffs) {
            const diffPath = record(diff)?.path
            if (typeof diffPath === 'string') { paths.add(diffPath); hasDiffPath = true }
          }
          if (call?.name === 'write' || call?.name === 'edit') {
            if (call.path !== undefined) paths.add(call.path)
            else if (!hasDiffPath) paths.add('')
          } else if (!READ_ONLY_TOOLS.has(call?.name ?? '')) {
            // Shell and unknown tools may have additional unreported writes.
            paths.add('')
          }
        }
        lastSeq = Math.max(lastSeq, entries.at(-1)?.event.seq ?? -1)
        if (initial || replace) paths.add('')
        if (paths.size > 0) listener([{ type: 'server-request', method: 'session/event', payload: {
          type: 'session/event', sessionId, view: { view: { locations: [...paths].map(path => ({ path })) } },
        } }])
      }
      const off = session.eventSource.subscribe(() => { publish() })
      publish(true)
      return off
    },
  }
}
