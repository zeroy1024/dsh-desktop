import { expect, it, vi } from 'vitest'
import { fileEvents, type FileSession } from '../src/client/session-data.ts'
import { fileActivityPaths, openMux } from '../src/client/api.ts'
import { createRewindVisibilitySource, type EventWindow } from '../../rewind/src/client/event-visibility.ts'

it('observes resident tool events, including new files with empty diff metadata', () => {
  type Rows = ReturnType<FileSession['eventSource']['getSnapshot']>['entries']
  let entries: Rows = []
  const listeners = new Set<() => void>()
  const source = { getSnapshot: () => ({ entries }), subscribe: (fn: () => void) => {
    listeners.add(fn); return () => { listeners.delete(fn) }
  } }
  const paths = vi.fn()
  const off = openMux(fileEvents({ eventSource: source }, 's1'), frame => paths(fileActivityPaths(frame, 's1')))
  expect(paths).toHaveBeenCalledWith([''])
  paths.mockClear()
  entries = [
    { type: 'event', event: { type: 'tool/call', seq: 0, data: { callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'src/new.ts' }) } } },
    { type: 'event', event: { type: 'tool/result', seq: 1, data: { message: { source: { callId: 'c1' } }, meta: { diffs: [] } } } },
  ]
  for (const fn of listeners) fn()
  expect(paths).toHaveBeenCalledWith(['src/new.ts'])
  for (const fn of listeners) fn()
  expect(paths).toHaveBeenCalledOnce()
  off()
  expect(listeners.size).toBe(0)
})

it('reconciles inactive work, consumes append deltas, and tolerates tool-private metadata', () => {
  type Window = ReturnType<FileSession['eventSource']['getSnapshot']>
  const call = { type: 'event', event: { type: 'tool/call', seq: 1, data: { callId: 'x', name: 'edit', arguments: '{"path":"a.ts"}' } } }
  const result = { type: 'event', event: { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'x' } }, meta: { diffs: { custom: true } } } } }
  const chunk = { type: 'chunks', event: { type: 'chunkrow/text', seq: 2 } }
  let window: Window = { entries: [call] }
  let notify: () => void = vi.fn()
  const session = { eventSource: { getSnapshot: () => window, subscribe: (fn: () => void) => { notify = fn; return () => {} } } }
  const changes = vi.fn()
  const source = fileEvents(session, 's')
  const off = openMux(source, frame => changes(fileActivityPaths(frame, 's')))
  changes.mockClear()
  window = { entries: [call, chunk], change: { kind: 'append', entries: [chunk] } }
  notify()
  expect(changes).not.toHaveBeenCalled()
  window = { entries: [call, chunk, result], change: { kind: 'append', entries: [result] } }
  notify()
  expect(changes).toHaveBeenLastCalledWith(['a.ts'])
  off()
  changes.mockClear()
  openMux(source, frame => changes(fileActivityPaths(frame, 's')))
  expect(changes).toHaveBeenLastCalledWith(['a.ts', ''])
  window = { entries: [], change: { kind: 'replace', entries: [] } }
  notify()
  expect(changes).toHaveBeenLastCalledWith([''])
})


it('ignores read-only tool results, narrows writes, and reconciles shell or unknown tools', () => {
  type Window = ReturnType<FileSession['eventSource']['getSnapshot']>
  let window: Window = { entries: [] }
  let notify: () => void = vi.fn()
  const changes = vi.fn()
  openMux(fileEvents({ eventSource: {
    getSnapshot: () => window, subscribe: fn => { notify = fn; return () => {} },
  } }, 's'), frame => changes(fileActivityPaths(frame, 's')))
  changes.mockClear()
  let seq = 0
  const finish = (name: string, path = 'a.ts'): void => {
    const entries = [
      { type: 'event', event: { seq: ++seq, type: 'tool/call', data: { callId: 'c', name, arguments: JSON.stringify({ file_path: path }) } } },
      { type: 'event', event: { seq: ++seq, type: 'tool/result', data: { message: { source: { callId: 'c' } } } } },
    ]
    window = { entries: [...window.entries, ...entries], change: { kind: 'append', entries } }
    notify()
  }
  for (const name of ['read', 'glob', 'grep', 'web_search', 'web_fetch']) finish(name)
  expect(changes).not.toHaveBeenCalled()
  finish('write')
  expect(changes).toHaveBeenLastCalledWith(['a.ts'])
  finish('bash')
  expect(changes).toHaveBeenLastCalledWith([''])
  finish('custom-mutate')
  expect(changes).toHaveBeenLastCalledWith([''])
})

it('consumes 20,000 rewind-view streaming deltas without reading the full window', () => {
  let window: EventWindow = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  let notify: () => void = vi.fn()
  const view = createRewindVisibilitySource({ getSnapshot: () => window,
    subscribe: fn => { notify = fn; return () => {} } })
  const changes = vi.fn()
  const off = openMux(fileEvents({ eventSource: view.source }, 's'), changes)
  changes.mockClear()
  let fullReads = 0
  for (let seq = 0; seq < 20_000; seq++) {
    const entries = [{ type: 'event' as const, event: { seq, type: 'assistant/chunk' } }]
    window = { get entries() { fullReads += 1; return [] }, hasMore: false,
      revision: seq + 1, change: { kind: 'append', entries } }
    notify()
  }
  expect(fullReads).toBe(0)
  expect(changes).not.toHaveBeenCalled()
  off(); view.dispose()
})
