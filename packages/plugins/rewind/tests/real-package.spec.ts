/**
 * 真实包集成测试：直接驱动 vendor/dsh-cli 里打了 0012 补丁的
 * @deepseek-ai/dsh-session，验证墓碑在「发布产物」上真实生效（append 合法、
 * deriveMessages 截断、种子重放一致、持久化目录含该类型）。不需要 LLM。
 */
import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { REWIND_EVENT_TYPE } from '../src/shared.ts'

function userMessage(text: string, seq: number) {
  return {
    id: `msg-user-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never
}

function assistantMessage(text: string) {
  return {
    turn: 1,
    step: 1,
    message: {
      id: 'msg-assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fake', model: 'fake' },
    },
  } as never
}

/** 两个完整 turn；用户消息在 seq 1 与 seq 5。 */
function appendTwoTurns(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', userMessage('first', 1), { surfaceOp: 'append' })
  session.append('assistant/message', assistantMessage('answer 1'), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', userMessage('second', 5), { surfaceOp: 'append' })
  session.append('assistant/message', assistantMessage('answer 2'), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

describe('rewind tombstone on the vendored patched package', () => {
  it('truncates the derived model context and replays identically from a seed', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has(REWIND_EVENT_TYPE)).toBe(true)

    const session = Session.create(SessionId('integration'))
    appendTwoTurns(session)
    expect(session.deriveMessages()).toHaveLength(4)

    const marker = session.append(REWIND_EVENT_TYPE, { atSeq: 5 })
    expect(marker.seq).toBe(8)
    expect(session.deriveMessages()).toHaveLength(2)

    session.append('turn/start', { turn: 3 })
    session.append('user/message', userMessage('retry', 10), { surfaceOp: 'append' })
    expect(session.deriveMessages()).toHaveLength(3)

    // 种子重放（恢复路径的 fold 共用点）与 live 增量一致。
    const replayed = Session.create(SessionId('replay'), session.events)
    expect(replayed.deriveMessages()).toHaveLength(3)

    // 墓碑事件的 data 完整保留在原始日志里（审计/重放源）。
    expect(session.events.find(event => event.type === REWIND_EVENT_TYPE)?.data).toEqual({ atSeq: 5 })
  })

  it('rejects a malformed marker before it enters the log', () => {
    const session = Session.create(SessionId('bad'))
    appendTwoTurns(session)
    expect(() => session.append(REWIND_EVENT_TYPE, { atSeq: 999 })).toThrow(/invalid atSeq/)
    expect(session.events).toHaveLength(8)
  })

  it('documents the fork-resurrection semantics: a pre-marker seed fork revives withdrawn turns', () => {
    // SessionStore.fork 复制 events.slice(0, boundary + 1) 且不感知墓碑——这里
    // 用同款切片驱动（其行为由 ADR-0007「撤回后 fork 的语义」一节记录）：
    // boundary 落在墓碑之前时，子会话不含墓碑，被撤回的 turn 2 完整复活。
    const session = Session.create(SessionId('fork-source'))
    appendTwoTurns(session)
    const marker = session.append(REWIND_EVENT_TYPE, { atSeq: 5 })
    expect(session.deriveMessages()).toHaveLength(2)

    // fork 到 turn 1 结束（boundary = seq 3）：不含被撤回段，行为无关撤回。
    const earlyFork = Session.create(SessionId('fork-early'), session.events.slice(0, 4))
    expect(earlyFork.deriveMessages()).toHaveLength(2)

    // fork 到墓碑之前最后一个回合边界（boundary = seq 7）：seed 含被撤回的
    // turn 2 但不含墓碑——子会话派生出全部 4 条消息（复活）。
    const lateFork = Session.create(SessionId('fork-late'), session.events.slice(0, marker.seq))
    expect(lateFork.deriveMessages()).toHaveLength(4)

    // fork 覆盖墓碑（boundary = 墓碑自身）：截断随之复制，与源一致。
    const throughFork = Session.create(SessionId('fork-through'), session.events.slice(0, marker.seq + 1))
    expect(throughFork.deriveMessages()).toHaveLength(2)
  })
})
