// ActivityGroupRow: the summary row of one folded activity group — leading
// activity icon (thinking lamp / tool glyph while the segment runs, the
// aggregate checklist glyph once it closes) + headline + collapsed facts
// (finished-call counts and elapsed seconds while running) behind the shared
// DisclosureRow chrome. Expanded, the row hands every member back through
// `renderMember`, which renders the exact flattened seat, so unfolding is the
// transcript it folded.
//
// Prose-tailed members (a final reasoning + answer step) fold split: the
// reasoning half renders inside the group, the prose half renders right after
// the disclosure — always visible, folded or not — so the answer text sits
// where the flat flow would put it.
//
// Unexpected member: flow assembly ran on an earlier structure and a member
// is neither process-only nor a prose tail (e.g. interrupted mid-group). The
// row detects that through its own member subscription and flattens itself
// instead of hiding content — content-driven regrouping stays local to the
// one component that already subscribes to the members.

import { useEffect, useMemo, useState } from 'react'
import {
  DisclosureRow, IconApiOutline14, IconChecklistOutline14, IconThinkOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActivityGroupRowProps, ChatNode, ChatNodeRenderVariant } from './types.ts'
import { formatDuration, isFoldableNode, isProseTailNode, summarizeActivity } from './flow-group.ts'
import type { ActivitySummary } from './flow-group.ts'
import css from './ActivityGroupRow.module.css'

/** 完成态标题：统计片段按存在与否拼接（"3 个工具调用 · 2 次思考"）。 */
function settledHeadline(summary: ActivitySummary, t: ActivityGroupRowProps['t']): string {
  const parts: string[] = []
  const callCount = summary.toolCounts.reduce((total, entry) => total + entry.count, 0)
  if (callCount > 0) parts.push(t('group.toolCalls', { count: callCount }))
  if (summary.reasoningCount > 0) parts.push(t('group.thinkingSteps', { count: summary.reasoningCount }))
  return parts.join(' · ')
}

/**
 * Render one folded activity group: the summary row while collapsed, the
 * flattened members while expanded (a prose tail's reasoning half inside,
 * its prose half after the shell), and the bare members when a member has
 * outgrown the group entirely.
 * @param props - Owner currency (member nodes + member seat renderer) and locale seat.
 * @returns the group row.
 */
export function ActivityGroupRow({ nodes, renderMember, useSession, useChat, t }: ActivityGroupRowProps) {
  const [expanded, setExpanded] = useState(false)
  const memberKeys = useMemo(() => nodes.map(node => node.key), [nodes])
  // ChatView 只在结构变化时重建 flow，成员内容更新（工具落定、思考流入）
  // 不流经 props；摘要的实时性由这条订阅承担。投影保证节点引用稳定，因
  // 此只有成员内容真正变化时才触发本组件重渲染。
  const members = useChat(snapshot => memberKeys.map(key => snapshot.nodes.get(key)))
  const summary = useMemo(() => {
    const present: ChatNode[] = []
    for (const member of members) {
      if (member !== undefined) present.push(member as ChatNode)
    }
    return present.length === 0 ? undefined : summarizeActivity(present)
  }, [members])
  // 正文收尾成员：思考半段进组（reasoning-only 渲染），正文半段永远可见
  // （组壳后 prose-only 渲染，折叠与否无关）。流式中 text 块一出现即按此
  // 拆分，不需要等任何结构变化。
  const proseTails = useMemo(
    () => members.filter(member => member !== undefined && isProseTailNode(member as ChatNode)),
    [members],
  )
  const proseTailKeys = useMemo(
    () => new Set(proseTails.map(member => (member as ChatNode).key)),
    [proseTails],
  )
  // 非预期成员兜底（既非过程节点也非正文收尾，如组内中断）：就地展开为
  // 平铺成员，绝不能把内容藏进摘要。
  const degenerate = useMemo(
    () => members.some(member => member !== undefined
      && !isFoldableNode(member as ChatNode)
      && !isProseTailNode(member as ChatNode)),
    [members],
  )
  // 视觉态与数据态分离：工具间隙（上一调用已落定、下一调用尚未投影）里
  // 成员恰好全部 settled，但那是管道噪声而非段闭合。只要本组仍是流尾且
  // 会话在跑，就保持运行观感；段闭合（后随正文/用户消息，或回合结束）才
  // 定格为完成态。两个切片都是 primitive，不放大重渲染面。
  const sessionRunning = useSession(snapshot => snapshot.running)
  const flowTailKey = useChat(snapshot => snapshot.order.at(-1))
  const isFlowTail = flowTailKey !== undefined && memberKeys.includes(flowTailKey)
  const running = (summary?.running ?? false) || (sessionRunning && isFlowTail)
  // 秒表只在组运行时走 interval；settled 后耗时刻在末成员时间上。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [running])

  // 图标随当前活动切换（与成员行同一 14px 线性语言）：思考中=灯泡（与
  // Think 行同形），工具活动=bash 行同款执行图标；段闭合后定格为聚合
  // 清单图标。状态由扫掠与标题承载，图标只表达"正在做什么/做完了"。
  const icon = running
    ? (summary?.thinking === true
      ? <IconThinkOutline14 size={14} />
      : <IconApiOutline14 size={14} />)
    : <IconChecklistOutline14 size={14} />

  if (degenerate) {
    return <div className={css.members}>{members.map(member => member !== undefined && renderMember(member.key))}</div>
  }
  if (summary === undefined) return null
  const startedAt = summary.startedAt
  const endAt = running ? now : summary.lastActivityAt
  const duration = formatDuration(Math.max(0, endAt - startedAt))
  const headline = running
    ? (
      summary.thinking
        ? t('group.thinking')
        // 间隙期没有运行中成员：标题定格在最近完成的工具上，连文字都不跳。
        : summary.runningToolName ?? summary.lastToolName ?? t('group.working')
    )
    : settledHeadline(summary, t)
  // 运行中：标题是当前活动，折叠段补已完成统计与耗时（figma 进行中形态）；
  // 完成后：标题就是统计摘要，折叠段只剩耗时（figma 完成形态）。
  const facts: string[] = []
  const callCount = summary.toolCounts.reduce((total, entry) => total + entry.count, 0)
  if (running && callCount > 0) facts.push(t('group.toolCalls', { count: callCount }))
  if (running && summary.reasoningCount > 0) {
    facts.push(t('group.thinkingSteps', { count: summary.reasoningCount }))
  }
  const memberVariant = (node: ChatNode): ChatNodeRenderVariant | undefined =>
    proseTailKeys.has(node.key) ? 'reasoning-only' : undefined
  return (
    <div className={css.root} data-state={running ? 'running' : 'ok'}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={icon}
        title={headline}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={running
          ? (
            <>
              <span className={css.separator} aria-hidden />
              <span className={css.summary}>
                {facts.length > 0 ? `${facts.join(' · ')} · ${duration}` : duration}
              </span>
            </>
          )
          : null}
      >
        {/* 惰性构造成员：JSX 参数是立即求值的，折叠时不得触碰 renderMember。
            正文收尾成员在展开区只渲染思考半段。 */}
        {expanded
          ? (
            <div className={`${css.members} ${css.grouped}`}>
              {nodes.map(node => renderMember(node.key, memberVariant(node)))}
            </div>
          )
          : null}
      </DisclosureRow>
      {/* 正文半段在组壳之后、折叠与否都渲染——回答正文永远可见，位置与
          平铺流一致。 */}
      {proseTails.map(member => member !== undefined && (
        <div key={member.key} className={css.proseHalf}>
          {renderMember(member.key, 'prose-only')}
        </div>
      ))}
    </div>
  )
}
