/**
 * ReviewPage：审查面板页（人审 agent 改动，MVP = 会话内改动源）。
 *
 * 数据面：session.history 全量回拉（尾页起步、beforeSeq 向前翻、页上限保护）
 * 聚合成按文件的编辑时间线；active 时观察共享连接信封做 live 增量——seq 连续
 * 才增量应用，跳跃（订阅空窗漏帧）即静默全量重拉收敛，重复投递按 seq 去重。
 * 交互面：已审标记与评论草稿都是按会话隔离的页面内存态（页面永不卸载，tab
 * 切换只翻转 active）；草稿一键组装为一条普通用户消息回灌会话（session.prompt）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchHistoryPage, openSessionSignals, sendReviewMessage,
  HISTORY_PAGE_LIMIT, type HistoryEntryLite,
} from './api.ts'
import { createAggregator, type Aggregator, type FileReview, type ReviewAggregation } from './aggregate.ts'
import { sameAnchor, serializeDrafts, type CommentDraft } from './comments.ts'
import { FileSection } from './FileSection.tsx'
import { DraftsTray } from './DraftsTray.tsx'
import type { LineAnchor } from './ReviewDiff.tsx'
import type { ReviewPageProps } from './types.ts'
import css from './ReviewPage.module.css'

/** 聚合状态机：loading / error / ready（truncated 标记页上限截断）。 */
type AggregationState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ReviewAggregation; truncated: boolean }

const EMPTY_REVIEWED_EDITS: ReadonlySet<number> = new Set()
const EMPTY_DRAFTS: readonly CommentDraft[] = []

/**
 * 渲染审查页。
 * @param props - 框架/容器注入的完整 props（见 ReviewPageProps）。
 * @returns 页面元素树。
 */
export function ReviewPage({ sessionId, active, envelopeSource, t }: ReviewPageProps) {
  const [aggregation, setAggregation] = useState<AggregationState>({ status: 'loading' })
  const [sortMode, setSortMode] = useState<'changes' | 'path'>('changes')
  const [noticeVisible, setNoticeVisible] = useState(true)
  /** 已审编辑事件（seq）与草稿按会话分桶（页面内存态；切会话互不影响）。
   *  已审锚定 seq 而非路径：agent 的新编辑是新 seq，天然未审——文件级
   *  「部分已审/已审」是派生态，不落存储。 */
  const [reviewedBySession, setReviewedBySession] = useState(() => new Map<string, Set<number>>())
  const [draftsBySession, setDraftsBySession] = useState(() => new Map<string, CommentDraft[]>())
  const [expandedPaths, setExpandedPaths] = useState(() => new Set<string>())
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [sentCount, setSentCount] = useState(0)

  const aggregatorRef = useRef<Aggregator | null>(null)
  /** 会话纪元：sessionId 变更/重挂时递增，拒旧异步回写。 */
  const epochRef = useRef(0)
  /** live 处理器触发重拉的稳定句柄（避免 effect 依赖抖动）。 */
  const reloadRef = useRef<() => void>(() => {})

  const reviewedEdits = reviewedBySession.get(sessionId) ?? EMPTY_REVIEWED_EDITS
  const drafts = draftsBySession.get(sessionId) ?? EMPTY_DRAFTS

  const loadAll = useCallback(async (epoch: number, silent: boolean): Promise<void> => {
    if (!silent) setAggregation({ status: 'loading' })
    try {
      // 尾页起步向前翻，页数组 unshift 后摊平即 seq 升序全量。
      const pages: HistoryEntryLite[][] = []
      let beforeSeq: number | undefined
      let truncated = false
      for (let fetched = 0; ; fetched++) {
        if (fetched >= HISTORY_PAGE_LIMIT) {
          truncated = true
          break
        }
        const page = await fetchHistoryPage(sessionId, beforeSeq)
        if (epoch !== epochRef.current) return
        pages.unshift(page.events)
        if (!page.hasMore || page.events.length === 0) break
        beforeSeq = page.events[0].event.seq
      }
      const entries = pages.flat().toSorted((a, b) => a.event.seq - b.event.seq)
      const aggregator = createAggregator()
      for (const entry of entries) aggregator.apply(entry)
      if (epoch !== epochRef.current) return
      aggregatorRef.current = aggregator
      setAggregation({ status: 'ready', data: aggregator.result(), truncated })
    } catch {
      if (epoch !== epochRef.current) return
      aggregatorRef.current = null
      setAggregation({ status: 'error' })
    }
  }, [sessionId])

  // 会话切换：纪元推进拒旧回写，展开态/发送态复位，全量重拉。
  useEffect(() => {
    const epoch = ++epochRef.current
    setExpandedPaths(new Set())
    setSendState('idle')
    void loadAll(epoch, false)
  }, [loadAll])

  // live 增量：仅 active + ready 时订阅；切走即退订（页面保持挂载）。
  // 依赖收敛到布尔 ready：事件批到达用函数式 setAggregation 原地更新，
  // 避免每批事件都重订阅。
  const ready = aggregation.status === 'ready'
  useEffect(() => {
    if (!active || !ready) return
    const dispose = openSessionSignals(envelopeSource, sessionId, (signal) => {
      const aggregator = aggregatorRef.current
      if (aggregator === null) return
      const base = aggregator.result()
      if (signal.kind === 'subscribed') {
        // 重连后的订阅基线：落后于已聚合水位即静默重拉。
        if (signal.lastSeq > base.appliedThroughSeq) reloadRef.current()
        return
      }
      if (signal.event.seq <= base.appliedThroughSeq) return
      if (signal.event.seq > base.appliedThroughSeq + 1) {
        // seq 跳跃 = 订阅空窗漏帧，全量重拉收敛（确定性优先）。
        reloadRef.current()
        return
      }
      aggregator.apply({ event: signal.event, view: signal.view })
      setAggregation((prev) => prev.status === 'ready'
        ? { ...prev, data: aggregator.result() }
        : prev)
    })
    return dispose
  }, [active, ready, sessionId, envelopeSource])

  // 重拉句柄稳定化（live effect 内引用最新 loadAll 而不进依赖）。
  useEffect(() => {
    reloadRef.current = (): void => { void loadAll(epochRef.current, true) }
  }, [loadAll])

  // 发送态回落：sent/failed 展示 3s 后回 idle。
  useEffect(() => {
    if (sendState === 'idle' || sendState === 'sending') return
    const timer = window.setTimeout(() => { setSendState('idle') }, 3000)
    return () => { window.clearTimeout(timer) }
  }, [sendState])

  const files: readonly FileReview[] = useMemo(() => {
    if (aggregation.status !== 'ready') return []
    const list = aggregation.data.files
    if (sortMode === 'path') {
      return list.toSorted((a, b) => (a.path < b.path ? -1 : 1))
    }
    return list
  }, [aggregation, sortMode])

  const totals = useMemo(() => {
    if (aggregation.status !== 'ready') return { added: 0, removed: 0 }
    return aggregation.data.edits.reduce(
      (acc, edit) => ({ added: acc.added + edit.added, removed: acc.removed + edit.removed }),
      { added: 0, removed: 0 },
    )
  }, [aggregation])

  const draftsByPath = useMemo(() => {
    const map = new Map<string, number>()
    for (const draft of drafts) map.set(draft.path, (map.get(draft.path) ?? 0) + 1)
    return map
  }, [drafts])

  /** 全部编辑是否都已审——决定摘要主控开关的形态（标记 ⇄ 取消）。 */
  const allReviewed = aggregation.status === 'ready'
    && aggregation.data.edits.length > 0
    && reviewedEdits.size >= aggregation.data.edits.length

  const toggleEditReviewed = (seq: number): void => {
    setReviewedBySession((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(sessionId) ?? [])
      if (set.has(seq)) set.delete(seq)
      else set.add(seq)
      next.set(sessionId, set)
      return next
    })
  }

  /** 文件级批量控制：全已审则清空该文件的全部 seq，否则全部标记。 */
  const toggleFileReviewed = (file: FileReview): void => {
    setReviewedBySession((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(sessionId) ?? [])
      const fileFullyReviewed = file.edits.every(edit => set.has(edit.seq))
      for (const edit of file.edits) {
        if (fileFullyReviewed) set.delete(edit.seq)
        else set.add(edit.seq)
      }
      next.set(sessionId, set)
      return next
    })
  }

  const markAllReviewed = (): void => {
    setReviewedBySession((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(sessionId) ?? [])
      for (const file of files) {
        for (const edit of file.edits) set.add(edit.seq)
      }
      next.set(sessionId, set)
      return next
    })
  }

  const unmarkAllReviewed = (): void => {
    setReviewedBySession((prev) => {
      const next = new Map(prev)
      next.set(sessionId, new Set())
      return next
    })
  }

  const addDraft = (editSeq: number, anchor: LineAnchor, comment: string): void => {
    const path = files.find(file => file.edits.some(edit => edit.seq === editSeq))?.path
    if (path === undefined) return
    setDraftsBySession((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(sessionId) ?? [])]
      const draft: CommentDraft = { path, editSeq, ...anchor, comment }
      const existing = list.findIndex(item => sameAnchor(item, draft))
      if (existing >= 0) list[existing] = draft
      else list.push(draft)
      next.set(sessionId, list)
      return next
    })
  }

  const removeDraft = (index: number): void => {
    setDraftsBySession((prev) => {
      const next = new Map(prev)
      const list = [...(next.get(sessionId) ?? [])]
      list.splice(index, 1)
      next.set(sessionId, list)
      return next
    })
  }

  const clearDrafts = (): void => {
    setDraftsBySession((prev) => {
      const next = new Map(prev)
      next.set(sessionId, [])
      return next
    })
  }

  const sendDrafts = (): void => {
    if (drafts.length === 0 || sendState === 'sending') return
    const filesByPath = new Map(files.map(file => [file.path, file]))
    const lines = drafts.map((draft) => {
      const file = filesByPath.get(draft.path)
      const ordinal = file !== undefined && file.edits.length > 1
        ? file.edits.findIndex(edit => edit.seq === draft.editSeq) + 1
        : undefined
      return { path: draft.path, ordinal, lineText: draft.lineText, comment: draft.comment }
    })
    const text = serializeDrafts(lines, t('comments.header'))
    if (text === undefined) return
    setSendState('sending')
    void sendReviewMessage(sessionId, text).then(() => {
      setSentCount(lines.length)
      setSendState('sent')
      clearDrafts()
    }).catch(() => {
      // 错误码不细分：内联提示统一「发送失败」。
      setSendState('failed')
    })
  }

  const toggleExpanded = (path: string): void => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className={css.root}>
      {noticeVisible && (
        <div className={css.notice}>
          <span className={css.noticeText}>{t('notice.body')}</span>
          <button type="button" className={css.noticeDismiss} onClick={() => { setNoticeVisible(false) }}>
            {t('notice.dismiss')}
          </button>
        </div>
      )}

      {aggregation.status === 'error' && (
        <div className={css.stateBox}>
          <span>{t('error.load')}</span>
          <button type="button" className={css.ghostBtn} onClick={() => { void loadAll(++epochRef.current, false) }}>
            {t('error.retry')}
          </button>
        </div>
      )}

      {aggregation.status === 'loading' && <div className={css.stateBox}>{t('summary.loading')}</div>}

      {aggregation.status === 'ready' && aggregation.data.files.length === 0 && (
        <div className={css.emptyState}>
          <div className={css.emptyTitle}>{t('empty.title')}</div>
          <div className={css.emptyGuide}>{t('empty.guide')}</div>
        </div>
      )}

      {aggregation.status === 'ready' && aggregation.data.files.length > 0 && (
        <>
          <div className={css.summaryBar}>
            <span className={css.summaryStat}>{t('summary.fileCount', { n: files.length })}</span>
            <span className={css.summaryStat}>{t('summary.editCount', { n: aggregation.data.edits.length })}</span>
            <span className={css.summaryStat}>
              <span className={css.addCount}>+{totals.added}</span>
              {' '}
              <span className={css.delCount}>-{totals.removed}</span>
            </span>
            {aggregation.truncated && <span className={css.summaryTruncated}>{t('summary.truncated')}</span>}
            <span className={css.summarySpacer} />
            <button
              type="button"
              className={css.ghostBtn}
              title={sortMode === 'changes' ? t('summary.sortByPath') : t('summary.sortByChanges')}
              onClick={() => { setSortMode(sortMode === 'changes' ? 'path' : 'changes') }}
            >
              {sortMode === 'changes' ? t('summary.sortByChanges') : t('summary.sortByPath')}
            </button>
            {/* 主控开关（非追加按钮）：未全审 = 全部标记；已全审 = 整体翻转为取消 */}
            <button
              type="button"
              className={css.ghostBtn}
              onClick={allReviewed ? unmarkAllReviewed : markAllReviewed}
            >
              {allReviewed ? t('summary.unmarkAll') : t('summary.markAll')}
            </button>
            <button
              type="button"
              className={css.iconBtn}
              title={t('action.refresh')}
              aria-label={t('action.refresh')}
              onClick={() => { void loadAll(epochRef.current, true) }}
            >
              <IconRefreshOutline14 size={14} />
            </button>
          </div>
          <div className={css.fileList}>
            {files.map((file) => (
              <FileSection
                key={file.path}
                file={file}
                reviewedEdits={reviewedEdits}
                expanded={expandedPaths.has(file.path)}
                draftsCount={draftsByPath.get(file.path) ?? 0}
                t={t}
                onToggleExpanded={() => { toggleExpanded(file.path) }}
                onToggleEditReviewed={toggleEditReviewed}
                onToggleFileReviewed={() => { toggleFileReviewed(file) }}
                onLineComment={addDraft}
              />
            ))}
          </div>
        </>
      )}

      <DraftsTray
        drafts={drafts}
        sendState={sendState}
        sentCount={sentCount}
        t={t}
        onRemove={removeDraft}
        onSend={sendDrafts}
        onClear={clearDrafts}
      />
    </div>
  )
}
