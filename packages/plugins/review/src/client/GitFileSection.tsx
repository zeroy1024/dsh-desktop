/**
 * GitFileSection：git 模式的文件分区——头部（路径/状态徽标/±计数/进度/
 * 三态勾选/撤销/复制）+ 带行号的 hunk 卡片。与 FileSection（会话模式）
 * 平行而非复用：git 侧的 diff 行带精确行号（unified diff 解析产物），
 * 且多一个撤销动作（唯一写路径，两步确认）。
 */
import { useState } from 'react'
import {
  IconCheckOutline14, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCloseFill14, IconCopyOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitFile, GitHunk } from './gitdiff.ts'
import { copyText } from './copy.ts'
import type { Translate } from './types.ts'
import css from './ReviewPage.module.css'

export interface GitFileSectionProps {
  file: GitFile
  /** porcelain 状态码徽标（M/A/D/R/??）。 */
  status: string
  reviewed: boolean
  expanded: boolean
  draftsCount: number
  armedRevert: boolean
  showRevert: boolean
  t: Translate
  onToggleExpanded: () => void
  onToggleReviewed: () => void
  onRevert: () => void
  /** 行评论提交（行号精确锚定；rowIndex 为 hunk 内全局行索引，折叠/展开一致，供同锚去重）。 */
  onLineComment: (hunkIndex: number, rowIndex: number, line: number | undefined, lineText: string, comment: string) => void
}

/**
 * 渲染一个 git 文件分区。
 * @param props - see {@link GitFileSectionProps}.
 * @returns 分区元素树。
 */
export function GitFileSection({
  file, status, reviewed, expanded, draftsCount, armedRevert, showRevert, t,
  onToggleExpanded, onToggleReviewed, onRevert, onLineComment,
}: GitFileSectionProps) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle')

  const copyDiff = (): void => {
    if (copyState !== 'idle') return
    // 与 DiffBlock.copyText 同格式的 `- `/`+ ` 行；hunk 之间空行分隔。
    const blocks: string[] = []
    for (const hunk of file.hunks) {
      const rows = hunk.rows.map(row => `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`)
      if (rows.length > 0) blocks.push(rows.join('\n'))
    }
    void copyText(blocks.join('\n\n')).then((ok) => {
      setCopyState(ok ? 'ok' : 'fail')
      window.setTimeout(() => { setCopyState('idle') }, ok ? 1000 : 2000)
    })
  }

  return (
    <section className={`${css.fileSection}${reviewed ? ` ${css.fileSectionReviewed}` : ''}`}>
      <div className={css.fileHeader}>
        <button
          type="button"
          className={css.chevron}
          aria-expanded={expanded}
          aria-label={file.path}
          onClick={onToggleExpanded}
        >
          {expanded
            ? <IconChevronDownOutline14 size={14} />
            : <IconChevronRightOutline14 size={14} />}
        </button>
        <button type="button" className={css.filePath} title={file.path} onClick={onToggleExpanded}>
          <span className={css.filePathText}>{file.path}</span>
        </button>
        {file.binary
          ? <span className={css.fileEditCount}>{t('git.binary')}</span>
          : <span className={css.fileCounts}>
              <span className={css.addCount}>+{file.added}</span>
              {' '}
              <span className={css.delCount}>-{file.removed}</span>
            </span>}
        <span className={css.fileEditCount}>{status}</span>
        {draftsCount > 0 && <span className={css.fileDraftBadge}>{draftsCount}</span>}
        <button
          type="button"
          className={css.iconBtn}
          title={reviewed ? t('action.unmarkReviewed') : t('action.markReviewed')}
          aria-label={reviewed ? t('action.unmarkReviewed') : t('action.markReviewed')}
          aria-pressed={reviewed}
          onClick={onToggleReviewed}
        >
          {reviewed
            ? <span className={css.reviewBoxChecked}><IconCheckOutline14 size={9} /></span>
            : <span className={css.reviewBox} />}
        </button>
        {showRevert && (
          <button
            type="button"
            className={armedRevert ? css.revertBtnArmed : css.revertBtn}
            onClick={onRevert}
          >
            {armedRevert ? t('action.revertConfirm') : t('action.revert')}
          </button>
        )}
        <button
          type="button"
          className={`${css.iconBtn}${copyState === 'ok' ? ` ${css.iconBtnReviewed}` : ''}${copyState === 'fail' ? ` ${css.iconBtnFail}` : ''}`}
          title={copyState === 'fail' ? t('action.copyFailed') : t('action.copyDiff')}
          aria-label={copyState === 'fail' ? t('action.copyFailed') : t('action.copyDiff')}
          onClick={copyDiff}
        >
          {copyState === 'ok' && <IconCheckOutline14 size={14} />}
          {copyState === 'fail' && <IconCloseFill14 size={14} />}
          {copyState === 'idle' && <IconCopyOutline16 size={14} />}
        </button>
      </div>
      {expanded && !file.binary && (
        <div className={`${css.fileBody} ${css.fileBodyGit}`}>
          {file.hunks.map((hunk, hunkIndex) => (
            <GitHunkCard
              key={hunkIndex}
              hunk={hunk}
              hunkIndex={hunkIndex}
              commentable={!reviewed}
              t={t}
              onLineComment={(rowIndex, line, lineText, comment) => { onLineComment(hunkIndex, rowIndex, line, lineText, comment) }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 内联输入框状态。 */
interface ComposerState {
  rowId: string
  line: number | undefined
  lineText: string
  value: string
}

const DEFAULT_GIT_MAX_LINES = 24

/** 单 hunk 卡片：带 old/new 行号列，行 hover 出评论按钮。 */
function GitHunkCard({
  hunk, hunkIndex, commentable, t, onLineComment,
}: {
  hunk: GitHunk
  hunkIndex: number
  /** 已审的文件禁止再留意见（按钮不渲染、输入框就地隐藏）。 */
  commentable: boolean
  t: Translate
  onLineComment: (rowIndex: number, line: number | undefined, lineText: string, comment: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [composer, setComposer] = useState<ComposerState | null>(null)
  // 已审禁评：按钮不渲染，已打开的输入框就地隐藏（unmark 后原样恢复）。
  const activeComposer = commentable ? composer : null

  if (hunk.rows.length === 0) return null

  const submit = (): void => {
    if (activeComposer !== null && activeComposer.value.trim() !== '') {
      const rowIndex = Number(activeComposer.rowId.slice(activeComposer.rowId.lastIndexOf('-') + 1))
      onLineComment(rowIndex, activeComposer.line, activeComposer.lineText, activeComposer.value.trim())
    }
    setComposer(null)
  }

  const hidden = hunk.rows.length - DEFAULT_GIT_MAX_LINES
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(DEFAULT_GIT_MAX_LINES / 2)
  const tailLines = DEFAULT_GIT_MAX_LINES - headLines
  const head = capped ? hunk.rows.slice(0, headLines) : hunk.rows
  const tail = capped ? hunk.rows.slice(hunk.rows.length - tailLines) : []

  const renderRows = (slice: typeof hunk.rows, offset: number): JSX.Element[] =>
    slice.map((row, index) => {
      // hunk 内全局行索引：折叠时 head/tail 两段同屏，不能用 slice 内索引
      // （会撞 React key，且评论锚与展开态漂移）。
      const rowIndex = offset + index
      const rowId = `${hunkIndex}-${rowIndex}`
      const rowComposer = activeComposer !== null && activeComposer.rowId === rowId ? activeComposer : null
      return (
        <div key={rowId}>
          <div className={row.kind === 'del' ? css.diffDel : row.kind === 'add' ? css.diffAdd : css.diffContext}>
            <span className={css.diffNums}>
              <span>{row.oldLine ?? ''}</span>
              <span>{row.newLine ?? ''}</span>
            </span>
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
                    : { rowId, line: row.newLine, lineText: row.text, value: '' })
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
        <div className={css.diffRows}>
          {renderRows(head, 0)}
          {capped && (
            <button type="button" className={css.diffExpand} onClick={() => { setExpanded(true); setComposer(null) }}>
              {t('diff.expand', { n: hidden })}
            </button>
          )}
          {expanded && hidden > 0 && (
            <button type="button" className={css.diffExpand} onClick={() => { setExpanded(false); setComposer(null) }}>
              {t('diff.collapse')}
            </button>
          )}
          {renderRows(tail, capped ? hunk.rows.length - tailLines : 0)}
        </div>
      </div>
    </div>
  )
}
