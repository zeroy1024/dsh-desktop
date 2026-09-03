/**
 * FileSection：一个文件的审查分区——可折叠头部（路径/进度/计数/批量已审/
 * 复制）+ 编辑时间线（每次 write/edit 一节，**已审标记做到编辑事件级**：
 * 锚定 seq，agent 的新编辑天然未审；文件头的勾选是三态批量控制，
 * 全部编辑已审才整节淡化——文件状态是派生值，不是存储值）。
 */
import { useState } from 'react'
import {
  IconCheckOutline14, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCloseFill14, IconCopyOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditEvent, FileReview } from './aggregate.ts'
import { copyText } from './copy.ts'
import { ReviewDiff, type LineAnchor } from './ReviewDiff.tsx'
import type { Translate } from './types.ts'
import css from './ReviewPage.module.css'

export interface FileSectionProps {
  file: FileReview
  /** 该会话全部已审编辑事件的 seq（改动级标记的事实来源）。 */
  reviewedEdits: ReadonlySet<number>
  expanded: boolean
  draftsCount: number
  t: Translate
  onToggleExpanded: () => void
  onToggleEditReviewed: (seq: number) => void
  /** 批量控制：文件内全已审则清空，否则全部标记。 */
  onToggleFileReviewed: () => void
  /** 行评论提交（分区补上编辑事件 seq 成完整草稿锚）。 */
  onLineComment: (editSeq: number, anchor: LineAnchor, comment: string) => void
}

/** 编辑时间 HH:MM（会话事件时间是 epoch 毫秒）。 */
function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** DiffBlock 同款行终止符规则（空文本 0 行，尾换行是终止符）。 */
function diffLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * 渲染一个文件的分区。
 * @param props - see {@link FileSectionProps}.
 * @returns 文件分区元素树。
 */
export function FileSection({
  file, reviewedEdits, expanded, draftsCount, t, onToggleExpanded, onToggleEditReviewed, onToggleFileReviewed, onLineComment,
}: FileSectionProps) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const reviewedCount = file.edits.filter(edit => reviewedEdits.has(edit.seq)).length
  const fileReviewed = reviewedCount === file.edits.length
  const filePartial = reviewedCount > 0 && !fileReviewed

  const copyDiff = (): void => {
    if (copyState !== 'idle') return
    // 与 DiffBlock.copyText 同格式的 `- `/`+ ` 行；多 hunk 按块空行分隔，
    // 不插任何路径行（路径已在分区标题）。
    const blocks: string[] = []
    for (const edit of file.edits) {
      for (const hunk of edit.hunks) {
        const rows: string[] = []
        if (hunk.oldText !== null) rows.push(...diffLines(hunk.oldText).map(l => `- ${l}`))
        rows.push(...diffLines(hunk.newText).map(l => `+ ${l}`))
        if (rows.length > 0) blocks.push(rows.join('\n'))
      }
    }
    void copyText(blocks.join('\n\n')).then((ok) => {
      setCopyState(ok ? 'ok' : 'fail')
      window.setTimeout(() => { setCopyState('idle') }, ok ? 1000 : 2000)
    })
  }

  return (
    <section className={`${css.fileSection}${fileReviewed ? ` ${css.fileSectionReviewed}` : ''}`}>
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
        <span className={css.fileCounts}>
          <span className={css.addCount}>+{file.added}</span>
          {' '}
          <span className={css.delCount}>-{file.removed}</span>
        </span>
        {/* 已审进度融合进编辑数徽章：n/total，标记一个 +1 */}
        <span className={css.fileEditCount}>{reviewedCount}/{file.edits.length}</span>
        {draftsCount > 0 && <span className={css.fileDraftBadge}>{draftsCount}</span>}
        <button
          type="button"
          className={css.iconBtn}
          title={fileReviewed ? t('action.unmarkReviewed') : t('action.markReviewed')}
          aria-label={fileReviewed ? t('action.unmarkReviewed') : t('action.markReviewed')}
          aria-pressed={fileReviewed}
          onClick={onToggleFileReviewed}
        >
          {fileReviewed && <span className={css.reviewBoxChecked}><IconCheckOutline14 size={9} /></span>}
          {filePartial && <span className={css.reviewBox}><span className={css.dashMark} /></span>}
          {!fileReviewed && !filePartial && <span className={css.reviewBox} />}
        </button>
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
      {expanded && (
        <div className={css.fileBody}>
          {file.edits.map((edit, index) => (
            <EditSection
              key={edit.seq}
              edit={edit}
              ordinal={file.edits.length > 1 ? index + 1 : undefined}
              reviewed={reviewedEdits.has(edit.seq)}
              t={t}
              onToggleReviewed={() => { onToggleEditReviewed(edit.seq) }}
              onLineComment={(anchor, comment) => { onLineComment(edit.seq, anchor, comment) }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 一次编辑的时间线节（独立已审标记；已审仅淡化本节）。 */
function EditSection({
  edit, ordinal, reviewed, t, onToggleReviewed, onLineComment,
}: {
  edit: EditEvent
  ordinal: number | undefined
  reviewed: boolean
  t: Translate
  onToggleReviewed: () => void
  onLineComment: (anchor: LineAnchor, comment: string) => void
}) {
  const toolKey = edit.tool === 'write' ? 'edit.write' : edit.tool === 'edit' ? 'edit.edit' : 'edit.other'
  return (
    <div className={`${css.editSection}${reviewed ? ` ${css.editSectionReviewed}` : ''}`}>
      <div className={css.editHeader}>
        <span className={css.editTool}>{t(toolKey)}</span>
        {ordinal !== undefined && <span className={css.editOrdinal}>{t('edit.ordinal', { n: ordinal })}</span>}
        <span className={css.editTime}>{formatTime(edit.time)}</span>
        <span className={css.editCounts}>
          <span className={css.addCount}>+{edit.added}</span>
          {' '}
          <span className={css.delCount}>-{edit.removed}</span>
        </span>
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
      </div>
      <ReviewDiff hunks={edit.hunks} t={t} commentable={!reviewed} onLineComment={onLineComment} />
    </div>
  )
}
