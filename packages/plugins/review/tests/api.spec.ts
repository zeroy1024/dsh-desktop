import { describe, expect, it } from 'vitest'
import { openSessionSignals, type EnvelopeMessage, type EnvelopeSource } from '../src/client/api.ts'

type Listener = (batch: readonly EnvelopeMessage[]) => void

/** 可注信封源（file-browser 的 api.spec 同款）。 */
function source(): { source: EnvelopeSource; emit: (batch: readonly EnvelopeMessage[]) => void } {
  let listener: Listener | undefined
  return {
    source: {
      subscribeEnvelopes(next) {
        listener = next
        return () => { listener = undefined }
      },
    },
    emit(batch) { listener?.(batch) },
  }
}

describe('openSessionSignals', () => {
  it('只转发目标会话的 session/event 与 session/subscribed，其余全忽略', () => {
    const feed = source()
    const signals: unknown[] = []
    const dispose = openSessionSignals(feed.source, 's1', signal => { signals.push(signal) })

    feed.emit([
      { type: 'server-request', method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: { type: 'tool/result', seq: 5, time: 1 } } },
      { type: 'server-request', method: 'session/event', payload: { type: 'session/event', sessionId: 's2', event: { type: 'tool/result', seq: 6, time: 1 } } },
      { type: 'server-request', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 9 } },
      { type: 'server-request', method: 'session/queue', payload: { type: 'session/queue', sessionId: 's1', items: [] } },
      { type: 'client-request', method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: { type: 'x', seq: 7, time: 1 } } },
      { type: 'server-request', method: 'session/event', payload: { type: 'approval/requested', sessionId: 's1' } },
    ])

    expect(signals).toEqual([
      { kind: 'event', event: { type: 'tool/result', seq: 5, time: 1 } },
      { kind: 'subscribed', lastSeq: 9 },
    ])
    dispose()
  })

  it('session/event 帧携带宿主视图，畸形载荷宽容跳过', () => {
    const feed = source()
    const signals: unknown[] = []
    const dispose = openSessionSignals(feed.source, 's1', signal => { signals.push(signal) })

    feed.emit([
      { type: 'server-request', method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: { type: 'tool/result', seq: 1, time: 1 }, view: { for: 'result', view: { card: 'diff' } } } },
      { type: 'server-request', method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: null } },
      { type: 'server-request', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 'bad' } },
    ])

    expect(signals).toEqual([
      { kind: 'event', event: { type: 'tool/result', seq: 1, time: 1 }, view: { for: 'result', view: { card: 'diff' } } },
    ])
    dispose()
  })

  it('dispose 后不再接收', () => {
    const feed = source()
    let count = 0
    const dispose = openSessionSignals(feed.source, 's1', () => { count++ })
    dispose()
    feed.emit([{ type: 'server-request', method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: { type: 'x', seq: 1, time: 1 } } }])
    expect(count).toBe(0)
  })
})
