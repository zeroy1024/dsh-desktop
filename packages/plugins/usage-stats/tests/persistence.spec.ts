import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSummary } from '../src/index.ts'

it('reads packed persisted events and excludes the exact inherited logical prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-lineage-'))
  const ctx = new Context()
  const store = await ctx.plugin(SessionStore)
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  try {
    const time = Date.now()
    const turn = (number: number, offset: number, input: number): SessionEvent[] => [
      { type: 'turn/start', data: { turn: number } },
      { type: 'step/start', data: { turn: number, step: 1 } },
      ...['a', 'b', 'c'].map(text => ({ type: 'assistant/chunk', data: { turn: number, step: 1, chunk: { type: 'text-delta', index: 0, text } } })),
      { type: 'assistant/message', data: { turn: number, step: 1, message: { id: `m-${number}`, role: 'assistant', content: [{ type: 'text', text: 'abc' }], source: { kind: 'model', provider: 'test', model: 'test' } }, usage: { inputTokens: input, outputTokens: 1 } } },
      { type: 'step/end', data: { turn: number, step: 1 } },
      { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
    ].map((event, index) => ({ ...event, seq: offset + index, time: time + offset + index })) as SessionEvent[]
    const parent: SessionHeader = { version: 0, id: SessionId('parent'), createdAt: time, isSeeded: false }
    const seed = turn(1, 0, 109)
    await ctx.sessionPersistence.create(parent)
    await ctx.sessionPersistence.append(parent.id, seed)
    const child: SessionHeader = { ...parent, id: SessionId('child'), isSeeded: true, parentSession: parent.id }
    await ctx.sessionPersistence.create(child, SessionLogOffset(seed.length))
    await ctx.sessionPersistence.append(child.id, [...seed, ...turn(2, seed.length, 19)])
    const raw = await ctx.sessionPersistence.readRaw(child.id)
    expect(raw?.content).toContain('"text-chunks"')
    expect(raw?.inheritedEventCount).toBe(seed.length)
    const { summary, meta } = await computeSummary(ctx.sessionPersistence, undefined, time)
    expect(meta.failed).toBe(0)
    expect(summary.byModel[0]?.buckets).toMatchObject({ uncachedInput: 128, output: 2, requests: 2 })
    expect(summary.overall).toMatchObject({ turns: 2, subagentSessions: 0 })
  } finally {
    await persistence.dispose()
    await store.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
