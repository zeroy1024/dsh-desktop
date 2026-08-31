/**
 * Chat flow assembly: fold consecutive process-only nodes (reasoning-only
 * Assistant steps and tool calls) behind one summary group, and derive the
 * summary facts a group row renders. Pure functions over the keyed Chat
 * nodes; the view owns all subscription and interaction state.
 */
import type { AssistantBlock, ChatFlowItem, ChatNode } from './types.ts'

/** 一段至少要凑满的成员数：单个过程行没有折叠价值，保持平铺。 */
const MIN_MEMBERS = 2

/**
 * 判定一个 Chat 节点是否属于"过程性行"，即可以收进活动摘要组的成员。
 * 只有纯思考的 Assistant step（无正文、无图片）与工具调用可入组；出现
 * 对用户可见的正文即是断组信号。中断的 step 携带停止标记，是需要用户
 * 看到的终态，同样不入组。
 * @param node - 有序业务节点。
 * @returns 该节点是否可折叠进组。
 */
export function isFoldableNode(node: ChatNode): boolean {
  if (node.kind === 'tool-call') return true
  if (node.kind !== 'assistant-step') return false
  const data = node.data
  if (data.status === 'interrupted') return false
  // tool-call block 在流里从不自行渲染（由 tool-call 节点承担），视为过程内容。
  // 流式期间的稀疏索引不会进入回调，类型面上的元素总是完整 block。
  return !data.blocks.some(block => block.kind === 'text' || block.kind === 'image')
}

/**
 * 判定一个 Assistant step 是否是「正文收尾」step：思考之后跟着对用户
 * 可见的内容（text/image）。这类 step 参与折叠但按块拆分——思考半段进
 * 组，正文半段在组壳后平铺；正文永远完整可见。
 * @param node - 有序业务节点。
 * @returns 是否为正文收尾 step。
 */
export function isProseTailNode(node: ChatNode): boolean {
  if (node.kind !== 'assistant-step') return false
  const data = node.data
  if (data.status === 'interrupted') return false
  return data.blocks.some(block => block.kind === 'reasoning')
    && data.blocks.some(block => block.kind === 'text' || block.kind === 'image')
}

/**
 * 把 anchorSeq 升序的可见节点序列重组为节点/组交错序列。连续的过程段
 * （纯过程节点，或作为收尾的正文 step）凑满 {@link MIN_MEMBERS} 成组
 * （组 key 取组首成员 key，滚动锚定直接复用节点身份）；正文收尾 step
 * 入组即为段的终点——其后的过程行另起新组。不足的段与全部非过程节点
 * 保持平铺。纯函数：相同输入成员引用产出等价结构，供视图按结构变化
 * 记忆化。
 * @param nodes - 可见业务节点序列（ascending anchorSeq）。
 * @returns 装配后的渲染序列。
 */
export function foldNodes(nodes: readonly ChatNode[]): readonly ChatFlowItem[] {
  const items: ChatFlowItem[] = []
  let run: ChatNode[] = []
  const flush = (): void => {
    const head = run[0]
    if (run.length >= MIN_MEMBERS && head !== undefined) {
      items.push({ kind: 'group', key: head.key, nodes: run })
    }
    else {
      for (const node of run) items.push({ kind: 'node', key: node.key, node })
    }
    run = []
  }
  for (const node of nodes) {
    if (isFoldableNode(node)) {
      run.push(node)
      continue
    }
    // 正文收尾 step 作为段的最后一个成员入组（思考半段进组、正文半段由
    // 组行渲染在组壳后），并闭合本段：其后的过程行属于下一段。
    if (isProseTailNode(node) && run.length > 0) {
      run.push(node)
      flush()
      continue
    }
    flush()
    items.push({ kind: 'node', key: node.key, node })
  }
  flush()
  return items
}

/** 一个工具名字上的已完成调用计数。 */
export interface ActivityToolCount {
  readonly name: string
  readonly count: number
}

/** 摘要行渲染所需的组级事实，由成员当前内容派生。 */
export interface ActivitySummary {
  /** 任一成员仍在运行。 */
  readonly running: boolean
  /** 最新活动是思考流（标题显示"思考中…"）。 */
  readonly thinking: boolean
  /** 最新活动是运行中的工具时显示的工具名。 */
  readonly runningToolName: string | undefined
  /**
   * 倒序最后一个已落定工具的名字：段未闭合但成员恰好全部落定的间隙
   * （结果已投影、下一个调用尚未到达）里，标题保持显示它而不是翻转
   * 成完成态——工具间隙是管道噪声，段闭合才迁移状态。
   */
  readonly lastToolName: string | undefined
  /** 已完成工具按名字聚合计数（首次出现序）。 */
  readonly toolCounts: readonly ActivityToolCount[]
  /** 携带可见思考内容的 step 数。 */
  readonly reasoningCount: number
  /** 组首成员时间，运行中耗时的起点。 */
  readonly startedAt: number
  /** 末成员时间，settled 耗时的终点（运行中终点由视图提供时钟）。 */
  readonly lastActivityAt: number
}

function hasVisibleReasoning(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
}

/** 成员的流时间：工具取调用（或结果落定）时间，Assistant 取投影时间。 */
function nodeTime(node: ChatNode): number {
  // ChatNodeKind 是 merge-extensible：未知种类不应出现在组内，兜底 0 只
  // 是让计时保持可算，不改变成员资格。
  if (node.kind === 'tool-call') return node.data.root.time
  if (node.kind === 'assistant-step') return node.data.time
  return 0
}

/**
 * 从组成员的当前内容派生摘要事实。最新活动取倒序第一个运行中的成员；
 * 计数只统计已落定的调用与可见思考。
 * @param nodes - 组成员节点（ascending anchorSeq）。
 * @returns 摘要事实。
 */
export function summarizeActivity(nodes: readonly ChatNode[]): ActivitySummary {
  const counts = new Map<string, number>()
  let reasoningCount = 0
  let running = false
  let thinking = false
  let runningToolName: string | undefined
  let lastToolName: string | undefined
  for (const node of nodes) {
    if (node.kind === 'tool-call') {
      const root = node.data.root
      if ('kind' in root) {
        const name = root.call?.name ?? ''
        if (name !== '') {
          counts.set(name, (counts.get(name) ?? 0) + 1)
          lastToolName = name
        }
        continue
      }
      running = true
      // 正序扫描中后到的运行成员覆盖先前结论：标题只反映最新活动。
      runningToolName = root.name
      thinking = false
      continue
    }
    if (node.kind === 'assistant-step') {
      const data = node.data
      if (hasVisibleReasoning(data.blocks)) reasoningCount += 1
      if (data.status !== 'running') continue
      // 正序扫描中后到的运行成员覆盖先前结论：最新活动是 step 时，标题
      // 只反映 step（思考中，或尚无可见内容的"执行中"），先前运行中的
      // 工具名不再保留。
      running = true
      runningToolName = undefined
      const last = data.blocks.at(-1)
      thinking = last?.kind === 'reasoning'
      continue
    }
  }
  const toolCounts: ActivityToolCount[] = []
  for (const [name, count] of counts) toolCounts.push({ name, count })
  const first = nodes[0]
  const last = nodes.at(-1)
  return {
    running,
    thinking,
    runningToolName,
    lastToolName,
    toolCounts,
    reasoningCount,
    startedAt: first === undefined ? 0 : nodeTime(first),
    lastActivityAt: last === undefined ? 0 : nodeTime(last),
  }
}

/**
 * 把耗时毫秒折算为紧凑标签：一分钟内显示整秒，更长显示分与秒。
 * @param milliseconds - 经历时差。
 * @returns 如 `42s`、`1m 23s`。
 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}
