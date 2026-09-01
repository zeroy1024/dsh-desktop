import { describe, expect, it } from 'vitest'
import {
  fileActivityPaths, openMux, type EnvelopeMessage, type EnvelopeSource, type MuxFrameLite,
} from '../src/client/api.ts'

type Listener = (batch: readonly EnvelopeMessage[]) => void

function source(): {
  source: EnvelopeSource
  emit: (batch: readonly EnvelopeMessage[]) => void
  subscriptions: number
  disposals: number
} {
  let listener: Listener | undefined
  let subscriptions = 0
  let disposals = 0
  return {
    source: {
      subscribeEnvelopes(next) {
        subscriptions += 1
        listener = next
        return () => {
          disposals += 1
          if (listener === next) listener = undefined
        }
      },
    },
    emit(batch) { listener?.(batch) },
    get subscriptions() { return subscriptions },
    get disposals() { return disposals },
  }
}

function event(sessionId: string, view?: MuxFrameLite['view']): EnvelopeMessage {
  return {
    type: 'server-request',
    method: 'session/event',
    payload: { type: 'session/event', sessionId, ...(view === undefined ? {} : { view }) },
  }
}

describe('shared envelope mux observer', () => {
  it('subscribes once, forwards session/event payloads, and releases cleanly', () => {
    const feed = source()
    const frames: MuxFrameLite[] = []
    const dispose = openMux(feed.source, frame => { frames.push(frame) })

    expect(feed.subscriptions).toBe(1)
    feed.emit([event('s1')])
    expect(frames).toEqual([{ type: 'session/event', sessionId: 's1' }])

    dispose()
    expect(feed.disposals).toBe(1)
    feed.emit([event('s2')])
    expect(frames).toHaveLength(1)
  })

  it('ignores non-server envelopes, other methods, and malformed event payloads', () => {
    const feed = source()
    const frames: MuxFrameLite[] = []
    openMux(feed.source, frame => { frames.push(frame) })

    feed.emit([
      { type: 'client-request', method: 'session/event', payload: event('wrong-type') },
      { type: 'server-request', method: 'session/list', payload: { type: 'session/event', sessionId: 'wrong-method' } },
      { type: 'server-request', method: 'session/event', payload: { type: 'session/subscribed', sessionId: 'wrong-payload' } },
      { type: 'server-request', method: 'session/event', payload: { type: 'session/event' } },
      event('kept', { for: 'call', view: { diffs: [{ path: 'src/a.ts' }] } }),
    ])

    expect(frames).toHaveLength(1)
    expect(frames[0]?.sessionId).toBe('kept')
  })
})

describe('fileActivityPaths', () => {
  it('filters by target session and de-duplicates paths in first-seen order', () => {
    const frame: MuxFrameLite = event('s1', {
      for: 'result',
      view: {
        diffs: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 42 }],
        locations: [{ path: 'b.ts' }, { path: 'a.ts' }, { path: 'c.ts' }],
        card: 'read',
        path: 'c.ts',
      },
    }).payload as MuxFrameLite

    expect(fileActivityPaths(frame, 's2')).toEqual([])
    expect(fileActivityPaths(frame, 's1')).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('keeps the established diff → location → read path order', () => {
    const frame = event('s1', {
      view: { diffs: [{ path: 'diff.ts' }], locations: [{ path: 'location.ts' }], card: 'read', path: 'read.ts' },
    }).payload as MuxFrameLite
    expect(fileActivityPaths(frame, 's1')).toEqual(['diff.ts', 'location.ts', 'read.ts'])
  })
})
