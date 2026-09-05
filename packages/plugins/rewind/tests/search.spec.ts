import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import RewindSessionQueryEngine from '../src/session-query.ts'
import { REWIND_EVENT_TYPE } from '../src/shared.ts'

const fibers: Fiber[] = []
const paths: string[] = []
afterEach(async () => {
  for (const fiber of fibers.splice(0).toReversed()) await fiber.dispose()
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-search-'))
  paths.push(root)
  const ctx = new Context()
  fibers.push(await ctx.plugin(SessionProjectionRegistry))
  fibers.push(await ctx.plugin(SessionStore))
  return { ctx, root, config: { path: join(root, 'query.db') } }
}

function prompt(session: Session, text: string, turn: number): number {
  session.append('turn/start', { turn })
  const event = session.append('user/message', {
    id: `message-${turn}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as SessionEvent<'user/message'>['data'], { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return event.seq
}

describe('rewind semantic search on the published vendor packages', () => {
  it('updates live full-text and literal filters, invalidates cursors, and keeps exact audit reads', async () => {
    const { ctx, config } = await fixture()
    fibers.push(await ctx.plugin(RewindSessionQueryEngine, config))
    const session = ctx.sessions.create(SessionId('live'))
    const first = prompt(session, 'retained needle', 1)
    const second = prompt(session, 'withdrawn needle', 2)
    const page = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'needle', limit: 1 })
    expect(page.nextCursor).toBeDefined()
    session.append(REWIND_EVENT_TYPE, { atSeq: second })
    expect((await ctx.sessionQuery.searchSessions({ query: 'withdrawn' })).items).toEqual([])
    expect((await ctx.sessionQuery.filterEvents(session.id, [])).map(document => document.seq)).toEqual([first])
    expect((await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: SessionSeq(second) })).target.data)
      .toMatchObject({ content: [{ text: 'withdrawn needle' }] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'needle', limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: 'SESSION_QUERY_STALE_CURSOR' })

    prompt(session, 'replacement needle', 3)
    expect((await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'needle' })).items).toHaveLength(2)
    session.append(REWIND_EVENT_TYPE, { atSeq: first })
    prompt(session, 'final needle', 4)
    expect((await ctx.sessionQuery.searchSessions({ query: 'needle' })).items).toHaveLength(1)
    expect((await ctx.sessionQuery.filterEvents(session.id, [])).map(document => document.text)).toEqual(['final needle'])
  })

  it('rebuilds an old persisted index and reopens it with the same visibility', async () => {
    const { ctx, root, config } = await fixture()
    fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' }))
    const session = Session.create(SessionId('cold'))
    prompt(session, 'retained needle', 1)
    const second = prompt(session, 'withdrawn needle', 2)
    session.append(REWIND_EVENT_TYPE, { atSeq: second })
    prompt(session, 'replacement needle', 3)
    await ctx.sessionPersistence.create(session.header)
    await ctx.sessionPersistence.append(session.id, session.snapshotEvents())

    const old = await ctx.plugin(SqliteSessionQueryEngine, config)
    expect((await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'withdrawn' })).items).toHaveLength(1)
    await old.dispose()
    const next = await ctx.plugin(RewindSessionQueryEngine, config)
    expect((await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'withdrawn' })).items).toEqual([])
    expect((await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'needle' })).items).toHaveLength(2)
    await next.dispose()
    fibers.push(await ctx.plugin(RewindSessionQueryEngine, config))
    expect((await ctx.sessionQuery.searchSessions({ query: 'withdrawn' })).items).toEqual([])
    expect((await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'replacement' })).items).toHaveLength(1)
  })

  it('preserves the upstream search opt-in setting while correcting literal filters', async () => {
    const { ctx, config } = await fixture()
    fibers.push(await ctx.plugin(RewindSessionQueryEngine, { ...config, openAt: 'never' }))
    const session = ctx.sessions.create(SessionId('disabled-search'))
    const atSeq = prompt(session, 'withdrawn needle', 1)
    session.append(REWIND_EVENT_TYPE, { atSeq })
    expect(await ctx.sessionQuery.filterEvents(session.id, [])).toEqual([])
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toMatchObject({ code: 'SESSION_QUERY_SEARCH_DISABLED' })
  })
})
