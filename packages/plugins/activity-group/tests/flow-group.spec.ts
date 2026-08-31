import { describe, expect, it } from 'vitest'
import type {
  AssistantChatData, ChatFlowItem, ChatNode, RunningToolCall, ToolChatData, ToolResultNode,
} from '../src/client/types.ts'
import {
  foldNodes, formatDuration, isFoldableNode, isProseTailNode, summarizeActivity,
} from '../src/client/flow-group.ts'

const location = { kind: 'turn', turn: { status: 'closed', turn: 1 } } as ChatNode['location']

const running = (callId: string, name = 'bash', over: Partial<RunningToolCall> = {}): RunningToolCall => ({
  callId, name, argsRaw: '{"command":"ls"}', turn: 1, step: 1, time: 1_000, callView: null, subCalls: [], ...over,
})

const settled = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: '{"command":"ls"}' },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})

const toolNode = (key: string, anchorSeq: number, root: RunningToolCall | ToolResultNode): ChatNode<'tool-call'> => ({
  key, kind: 'tool-call', id: key, target: 'chat', anchorSeq, location, visibility: 'visible',
  data: { root } satisfies ToolChatData,
})

const stepNode = (key: string, anchorSeq: number, data: AssistantChatData): ChatNode<'assistant-step'> => ({
  key, kind: 'assistant-step', id: key, target: 'chat', anchorSeq, location, visibility: 'visible', data,
})

const reasoningStep = (key: string, anchorSeq: number, text = '想一想', status: AssistantChatData['status'] = 'settled'): ChatNode<'assistant-step'> =>
  stepNode(key, anchorSeq, { status, turn: 1, step: anchorSeq, blocks: [{ kind: 'reasoning', text }], time: anchorSeq * 1_000 })

const textStep = (key: string, anchorSeq: number, text = '结论'): ChatNode<'assistant-step'> =>
  stepNode(key, anchorSeq, { status: 'settled', turn: 1, step: anchorSeq, blocks: [{ kind: 'text', text }], time: anchorSeq * 1_000 })

// 断组用最小节点：foldNodes 只读 kind，data 用宽松断言（fixture 不追求
// 完整 user 载荷）。
const userNode = (key: string, anchorSeq: number): ChatNode =>
  ({ key, kind: 'user', id: key, target: 'chat', anchorSeq, location, visibility: 'visible', data: { seq: anchorSeq } }) as ChatNode

const proseTailStep = (key: string, anchorSeq: number, status: AssistantChatData['status'] = 'settled'): ChatNode<'assistant-step'> =>
  stepNode(key, anchorSeq, {
    status,
    turn: 1,
    step: anchorSeq,
    blocks: [{ kind: 'reasoning', text: '收尾思考' }, { kind: 'text', text: '最终回答' }],
    time: anchorSeq * 1_000,
  })

describe('isProseTailNode', () => {
  it('accepts reasoning+prose steps and rejects pure process or prose-only steps', () => {
    expect(isProseTailNode(proseTailStep('p1', 1))).toBe(true)
    expect(isProseTailNode(reasoningStep('s1', 2))).toBe(false)
    expect(isProseTailNode(textStep('s2', 3))).toBe(false)
    expect(isProseTailNode(toolNode('t1', 4, settled(4, 'c1')))).toBe(false)
    // Interrupted prose tails stay out of folding entirely.
    expect(isProseTailNode(stepNode('s3', 5, {
      status: 'interrupted', turn: 1, step: 5,
      blocks: [{ kind: 'reasoning', text: '中断' }, { kind: 'text', text: '半个回答' }], time: 5_000,
    }))).toBe(false)
  })
})

describe('isFoldableNode', () => {
  it('accepts tool calls and reasoning-only steps, rejects prose, images, interruptions, and other kinds', () => {
    expect(isFoldableNode(toolNode('t1', 1, running('c1')))).toBe(true)
    expect(isFoldableNode(toolNode('t2', 2, settled(2, 'c1')))).toBe(true)
    expect(isFoldableNode(reasoningStep('s1', 3))).toBe(true)
    // An empty streaming step is still process-only.
    expect(isFoldableNode(stepNode('s0', 0, {
      status: 'running', turn: 1, step: 0, blocks: [], time: 0,
    }))).toBe(true)
    expect(isFoldableNode(textStep('s2', 4))).toBe(false)
    expect(isFoldableNode(stepNode('s3', 5, {
      status: 'settled', turn: 1, step: 5, blocks: [{ kind: 'image', attachment: {} as never }], time: 5_000,
    }))).toBe(false)
    expect(isFoldableNode(stepNode('s4', 6, {
      status: 'interrupted', turn: 1, step: 6, blocks: [{ kind: 'reasoning', text: '中断的思考' }], time: 6_000,
    }))).toBe(false)
    expect(isFoldableNode(userNode('u1', 7))).toBe(false)
  })
})

describe('foldNodes', () => {
  it('folds a run of at least two process nodes under the first member key', () => {
    const items = foldNodes([
      reasoningStep('s1', 1),
      toolNode('t1', 2, settled(2, 'c1')),
      toolNode('t2', 3, settled(3, 'c2')),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'group', key: 's1' })
    const [group] = items
    if (group?.kind !== 'group') throw new Error('unreachable')
    expect(group.nodes.map(node => node.key)).toEqual(['s1', 't1', 't2'])
  })

  it('keeps a lone process node flat and splits runs at non-foldable nodes', () => {
    const items = foldNodes([
      toolNode('t1', 1, settled(1, 'c1')),
      textStep('s1', 2),
      toolNode('t2', 3, settled(3, 'c2')),
      toolNode('t3', 4, settled(4, 'c3')),
      userNode('u1', 5),
      toolNode('t4', 6, settled(6, 'c4')),
    ])
    expect(items.map(item => item.kind)).toEqual(['node', 'node', 'group', 'node', 'node'])
    expect(items.map(item => item.key)).toEqual(['t1', 's1', 't2', 'u1', 't4'])
  })

  it('folds a prose-tailed step as the segment closer: it joins the group and closes the run', () => {
    const items = foldNodes([
      toolNode('t1', 1, settled(1, 'c1')),
      toolNode('t2', 2, settled(2, 'c2')),
      proseTailStep('p1', 3),
      toolNode('t3', 4, settled(4, 'c3')),
    ])
    expect(items.map(item => item.kind)).toEqual(['group', 'node'])
    const [group] = items as readonly (Extract<ChatFlowItem, { kind: 'group' }> | undefined)[]
    if (group?.kind !== 'group') throw new Error('unreachable')
    expect(group.key).toBe('t1')
    expect(group.nodes.map(node => node.key)).toEqual(['t1', 't2', 'p1'])
    // The step after the prose tail opens a new segment (flat here: lone run).
    expect(items[1]).toMatchObject({ kind: 'node', key: 't3' })
  })

  it('keeps a lone prose-tailed step flat (nothing to fold it into)', () => {
    const items = foldNodes([proseTailStep('p1', 1)])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'node', key: 'p1' })
  })

  it('returns an empty sequence for an empty flow', () => {
    expect(foldNodes([])).toEqual([])
  })
})

describe('summarizeActivity', () => {
  it('counts settled calls per tool name and visible reasoning steps', () => {
    const summary = summarizeActivity([
      reasoningStep('s1', 1),
      toolNode('t1', 2, settled(2, 'c1', 'bash')),
      toolNode('t2', 3, settled(3, 'c2', 'read')),
      toolNode('t3', 4, settled(4, 'c3', 'bash')),
    ])
    expect(summary).toMatchObject({
      running: false,
      thinking: false,
      runningToolName: undefined,
      lastToolName: 'bash',
      toolCounts: [{ name: 'bash', count: 2 }, { name: 'read', count: 1 }],
      reasoningCount: 1,
      startedAt: 1_000,
      lastActivityAt: 4_000,
    })
  })

  it('reports the newest running member: a running tool, then a thinking step overrides it', () => {
    const toolRunning = summarizeActivity([
      reasoningStep('s1', 1),
      toolNode('t1', 2, running('c1', 'grep')),
    ])
    expect(toolRunning).toMatchObject({ running: true, thinking: false, runningToolName: 'grep', lastToolName: undefined })

    const thinkingLast = summarizeActivity([
      toolNode('t1', 2, running('c1', 'grep')),
      reasoningStep('s2', 3, '接着想', 'running'),
    ])
    expect(thinkingLast).toMatchObject({ running: true, thinking: true, runningToolName: undefined })
  })

  it('treats a running step without a visible reasoning tail as plain work', () => {
    const summary = summarizeActivity([
      stepNode('s1', 1, {
        status: 'running', turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: '前面的思考' }], time: 1_000,
      }),
      stepNode('s2', 2, {
        status: 'running', turn: 1, step: 2, blocks: [], time: 2_000,
      }),
    ])
    expect(summary).toMatchObject({ running: true, thinking: false, runningToolName: undefined })
  })

  it('skips settled calls whose call identity was lost in projection', () => {
    const orphan: ToolResultNode = { ...settled(1, 'c1'), call: null }
    const summary = summarizeActivity([toolNode('t1', 1, orphan)])
    expect(summary.toolCounts).toEqual([])
  })
})

describe('formatDuration', () => {
  it('renders whole seconds below a minute and minutes plus seconds beyond', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(41_900)).toBe('42s')
    expect(formatDuration(83_000)).toBe('1m 23s')
    expect(formatDuration(-5)).toBe('0s')
  })
})
