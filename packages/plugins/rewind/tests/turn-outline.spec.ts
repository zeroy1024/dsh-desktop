import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { rewindTurnOutlineProjection as projection } from '../src/turn-outline.ts'

const event = (seq: number, type: string, data: unknown): SessionEvent => ({ seq, time: seq, type, data }) as SessionEvent
const user = (seq: number, text: string) => event(seq, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistant = (seq: number, text: string) => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })

describe('rewind-aware turn outline', () => {
  it('removes withdrawn prompts even when turn/start precedes the rewind boundary, including on restore', () => {
    const events = [
      event(1, 'turn/start', { turn: 1 }), user(2, 'keep'), assistant(3, 'kept answer'), event(4, 'turn/end', { turn: 1 }),
      event(5, 'turn/start', { turn: 2 }), user(6, 'withdraw'), assistant(7, 'withdrawn answer'), event(8, 'turn/end', { turn: 2 }),
    ]
    let state = events.reduce(projection.apply, projection.init())
    expect(projection.wire.view(state)).toHaveLength(2)
    state = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
    state = projection.apply(state, event(9, 'dsh-desktop/session-rewind', { atSeq: 6 }))
    expect(projection.wire.view(state)).toEqual([{ turn: 1, seq: 1, prompt: 'keep', response: 'kept answer' }])
    state = projection.apply(state, event(10, 'turn/start', { turn: 3 }))
    state = projection.apply(state, user(11, 'new prompt'))
    expect(projection.wire.view(state).map(turn => turn.prompt)).toEqual(['keep', 'new prompt'])
  })

  it('preserves the original prompt but withdraws the response when rewinding a steering message', () => {
    const events = [event(1, 'turn/start', { turn: 1 }), user(2, 'original'), user(3, 'steer'), assistant(4, 'answer'), event(5, 'turn/end', { turn: 1 })]
    const state = projection.apply(events.reduce(projection.apply, projection.init()), event(6, 'dsh-desktop/session-rewind', { atSeq: 3 }))
    expect(projection.wire.view(state)).toEqual([{ turn: 1, seq: 1, prompt: 'original', response: '' }])
  })

  it.each([[{ type: 'image', data: {} }], [{ type: 'text', text: '  ' }]])('tracks the first human boundary even without a text preview', (...content) => {
    const first = event(2, 'user/message', { source: { kind: 'user' }, content })
    const state = [event(1, 'turn/start', { turn: 1 }), first, user(3, 'later steering'), assistant(4, 'answer'), event(5, 'turn/end', {})].reduce(projection.apply, projection.init())
    expect(projection.wire.view(state)[0]?.prompt).toBe('later steering')
    expect(projection.wire.view(projection.apply(state, event(6, 'dsh-desktop/session-rewind', { atSeq: 2 })))).toEqual([])
    expect(projection.wire.view(projection.apply(state, event(6, 'dsh-desktop/session-rewind', { atSeq: 3 })))).toEqual([{ turn: 1, seq: 1, prompt: '', response: '' }])
  })

  it('keeps the wire reference stable during streaming and irrelevant events', () => {
    let state = projection.apply(projection.init(), event(1, 'turn/start', { turn: 1 }))
    const wire = projection.wire.view(state)
    state = projection.apply(state, assistant(2, 'draft'))
    expect(projection.wire.view(state)).toBe(wire)
    expect(projection.apply(state, event(3, 'assistant/chunk', {}))).toBe(state)
  })
})
