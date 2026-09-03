/**
 * ReviewDiff：一个编辑事件的 hunk 渲染器——**一 hunk 一卡**。
 *
 * 为什么不直接用上游 DiffBlock：审查需要**行级评论锚点**（hover 行 → + →
 * 内联输入框），DiffBlock 没有交互面。这里按 DiffBlock 的同一套视觉约定
 * （--dsw-* token、`- `/`+ ` 前缀、22px 行高、pre 不折行、头尾折叠）自绘。
 *
 * 为什么按 hunk 分块而不是一块连排 + 分隔行：① 分散修改本就是多个独立
 * 变更，分卡忠实于语义；② 折叠上限落到**每个 hunk 内部**——连排时中段
 * 折叠恰好藏掉 hunk 边界，第二个 hunk 可能整块不可见；③ 路径只出现在
 * 文件分区标题，hunk 之间零分隔行（修复过「路径重复」缺陷）。精确行号
 * 锚定随 v1 git 改动源引入（数据无行号，见 aggregate.ts）。
 */
import { useMemo, useState } from 'react'
import type { FileDiffLite } from './api.ts'
import type { DraftSide } from './comments.ts'
import type { Translate } from './types.ts'
import css from './ReviewPage.module.css'

/** 一行的评论锚点（补齐 hunkIndex 后即完整草稿锚）。 */
export interface LineAnchor {
  hunkIndex: number
  side: DraftSide
  lineIndex: number
  lineText: string
}

export interface ReviewDiffProps {
  /** 一个编辑事件的全部 hunk（同一路径的多个散落替换 = 多张卡）。 */
  hunks: FileDiffLite[]
  t: Translate
  /** 单 hunk 的折叠上限（行数），默认 24。 */
  maxLines?: number
  /** 行评论提交（锚点 + 意见文本）。 */
  onLineComment: (anchor: LineAnchor, comment: string) => void
  /** 是否允许行级评论（已审的编辑禁止再留意见，false 时不渲染行按钮并收起输入框）。 */
  commentable?: boolean
}

/** 渲染行模型：kind 决定配色；content 行带评论锚点成分。 */
interface Row {
  id: string
  kind: 'del' | 'add'
  text: string
  side: DraftSide
  lineIndex: number
  lineText: string
}

/** 内联输入框状态：锚定行 + 文本。 */
interface ComposerState {
  rowId: string
  side: DraftSide
  lineIndex: number
  lineText: string
  value: string
}

/** DiffBlock 同款行终止符规则（空文本 0 行，尾换行是终止符）。 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** 单 hunk 的行模型（无 hunk 间分隔行；id 在 hunk 内唯一即可）。 */
function buildRows(hunk: FileDiffLite): Row[] {
  const rows: Row[] = []
  if (hunk.oldText !== null) {
    contentLines(hunk.oldText).forEach((text, lineIndex) => {
      rows.push({ id: `o-${lineIndex}`, kind: 'del', text, side: 'old', lineIndex, lineText: text })
    })
  }
  contentLines(hunk.newText).forEach((text, lineIndex) => {
    rows.push({ id: `n-${lineIndex}`, kind: 'add', text, side: 'new', lineIndex, lineText: text })
  })
  return rows
}

const DEFAULT_REVIEW_DIFF_MAX_LINES = 24

/**
 * 渲染一个编辑事件的 diff：每个 hunk 一张独立卡。
 * @param props - see {@link ReviewDiffProps}.
 * @returns hunk 卡片树；无行时返回 null。
 */
export function ReviewDiff({ hunks, t, maxLines = DEFAULT_REVIEW_DIFF_MAX_LINES, onLineComment, commentable = true }: ReviewDiffProps) {
  if (hunks.length === 0) return null
  return (
    <div className={css.diffStack}>
      {hunks.map((hunk, hunkIndex) => (
        <HunkBlock
          key={hunkIndex}
          hunk={hunk}
          hunkIndex={hunkIndex}
          t={t}
          maxLines={maxLines}
          commentable={commentable}
          onLineComment={onLineComment}
        />
      ))}
    </div>
  )
}

/** 单 hunk 卡片：自带折叠状态与行内评论输入框。 */
function HunkBlock({
  hunk, hunkIndex, t, maxLines, commentable, onLineComment,
}: {
  hunk: FileDiffLite
  hunkIndex: number
  t: Translate
  maxLines: number
  commentable: boolean
  onLineComment: ReviewDiffProps['onLineComment']
}) {
  const rows = useMemo(() => buildRows(hunk), [hunk])
  const [expanded, setExpanded] = useState(false)
  const [composer, setComposer] = useState<ComposerState | null>(null)
  // 已审禁评：按钮不渲染，已打开的输入框就地隐藏（unmark 后原样恢复）。
  const activeComposer = commentable ? composer : null

  if (rows.length === 0) return null

  const submit = (): void => {
    if (activeComposer !== null && activeComposer.value.trim() !== '') {
      onLineComment(
        { hunkIndex, side: activeComposer.side, lineIndex: activeComposer.lineIndex, lineText: activeComposer.lineText },
        activeComposer.value.trim(),
      )
    }
    setComposer(null)
  }

  // 头尾折叠算术与 DiffBlock 相同，但上限按单 hunk 计（分块的核心收益）。
  const hidden = rows.length - maxLines
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []

  /** 渲染一段连续行（含每行 sticky 评论按钮与内联输入框插位）。 */
  const renderRows = (slice: readonly Row[]): JSX.Element[] =>
    slice.map((row) => {
      const rowComposer = activeComposer !== null && activeComposer.rowId === row.id ? activeComposer : null
      return (
        <div key={row.id}>
          <div className={row.kind === 'del' ? css.diffDel : css.diffAdd}>
            <span className={css.diffText}>{row.text}</span>
            {commentable && (
              <button
                type="button"
                className={css.diffRowBtn}
                title={t('diff.comment')}
                aria-label={t('diff.comment')}
                onClick={() => {
                  setComposer(rowComposer !== null
                    ? null
                    : { rowId: row.id, side: row.side, lineIndex: row.lineIndex, lineText: row.lineText, value: '' })
                }}
              >
                +
              </button>
            )}
          </div>
          {rowComposer !== null && (
            <div className={css.composer}>
              <textarea
                className={css.composerInput}
                placeholder={t('diff.commentPlaceholder')}
                rows={2}
                autoFocus
                value={rowComposer.value}
                onChange={(event) => { setComposer({ ...rowComposer, value: event.target.value }) }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setComposer(null)
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
                }}
              />
              <div className={css.composerActions}>
                <button type="button" className={css.composerBtn} onClick={submit}>{t('diff.commentSubmit')}</button>
                <button type="button" className={css.composerBtn} onClick={() => { setComposer(null) }}>{t('diff.commentCancel')}</button>
              </div>
            </div>
          )}
        </div>
      )
    })

  return (
    <div className={css.diffBlock}>
      <div className={css.diffBody}>
        {renderRows(head)}
        {capped && (
          <button
            type="button"
            className={css.diffExpand}
            onClick={() => { setExpanded(true); setComposer(null) }}
          >
            {t('diff.expand', { n: hidden })}
          </button>
        )}
        {expanded && hidden > 0 && (
          <button type="button" className={css.diffExpand} onClick={() => { setExpanded(false); setComposer(null) }}>
            {t('diff.collapse')}
          </button>
        )}
        {renderRows(tail)}
      </div>
    </div>
  )
}
