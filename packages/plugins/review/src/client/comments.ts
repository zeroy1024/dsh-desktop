/**
 * 行级评论草稿模型与回灌序列化（纯函数）。
 *
 * 锚定现实：会话模式的 hunk 无行号（见 aggregate.ts 头注），所以锚点 =
 * 文件 + 编辑事件 seq + hunk 序 + 侧 + 行序 + 引用行文本。回灌消息以
 * 「路径 ·「引用行」 —— 意见」呈现，agent 按内容定位（Claude web 的
 * "at src/auth.ts:47" 行内评论回灌的会话模式等价物）。
 */

/** 评论锚定的 diff 侧。 */
export type DraftSide = 'old' | 'new'

/** 一条行级评论草稿（会话内存态，发送即成普通用户消息）。 */
export interface CommentDraft {
  path: string
  /** 锚定的编辑事件（EditEvent.seq）。 */
  editSeq: number
  hunkIndex: number
  side: DraftSide
  /** 该侧行序（0 起）。 */
  lineIndex: number
  /** 引用行文本（消歧与回灌定位的双重用途）。 */
  lineText: string
  comment: string
}

/** 两草稿是否同一锚点（同锚点重复添加 = 覆盖旧意见）。 */
export function sameAnchor(a: CommentDraft, b: CommentDraft): boolean {
  return a.path === b.path && a.editSeq === b.editSeq && a.hunkIndex === b.hunkIndex
    && a.side === b.side && a.lineIndex === b.lineIndex
}

/** 回灌消息的一行渲染输入（页面把聚合信息折算好再交给纯序列化）。 */
export interface DraftLineInput {
  path: string
  /** 同文件第几次编辑（1 起）；文件只被编辑一次时省略。 */
  ordinal?: number
  /** 引用行文本；缺省 = 文件级意见。 */
  lineText?: string
  comment: string
}

/** 回灌消息的行模板：路径（第 N 次编辑）·「引用行」 —— 意见。 */
export function renderDraftLine(line: DraftLineInput): string {
  const head = line.ordinal === undefined ? line.path : `${line.path}（第 ${line.ordinal} 次）`
  const anchor = line.lineText === undefined || line.lineText === '' ? '' : ` ·「${line.lineText}」`
  return `- ${head}${anchor} —— ${line.comment}`
}

/** 组装回灌消息：表头 + 每条草稿一行。空草稿列表返回 undefined（调用方不必发）。 */
export function serializeDrafts(lines: readonly DraftLineInput[], header: string): string | undefined {
  if (lines.length === 0) return undefined
  return [header, ...lines.map(renderDraftLine)].join('\n')
}

/** 草稿的展示锚点（列表项摘要）：路径 + 引用行截断。 */
export function draftAnchorLabel(draft: CommentDraft, maxChars = 48): string {
  const text = draft.lineText.length > maxChars ? `${draft.lineText.slice(0, maxChars - 1)}…` : draft.lineText
  return `${draft.path} ·「${text}」`
}
