/**
 * DraftsTray：审查意见草稿托盘（页面底部）。列出全部行级草稿，
 * 一键回灌为一条会话消息（发送即清空；发送态内联呈现，不用浮层）。
 */
import { IconSendOutline14, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { draftAnchorLabel, type CommentDraft } from './comments.ts'
import type { Translate } from './types.ts'
import css from './ReviewPage.module.css'

export interface DraftsTrayProps {
  drafts: readonly CommentDraft[]
  sendState: 'idle' | 'sending' | 'sent' | 'failed'
  sentCount: number
  t: Translate
  onRemove: (index: number) => void
  onSend: () => void
  onClear: () => void
}

/**
 * 渲染草稿托盘；无草稿且无发送态时不占位。
 * @param props - see {@link DraftsTrayProps}.
 * @returns 托盘元素树或 null。
 */
export function DraftsTray({ drafts, sendState, sentCount, t, onRemove, onSend, onClear }: DraftsTrayProps) {
  if (drafts.length === 0 && sendState === 'idle') return null

  return (
    <div className={css.draftsTray}>
      {drafts.length > 0 && (
        <>
          <div className={css.draftsHeader}>
            <span className={css.draftsTitle}>{t('drafts.title', { n: drafts.length })}</span>
            <div className={css.draftsHeaderActions}>
              <button
                type="button"
                className={css.primaryBtn}
                disabled={sendState === 'sending'}
                onClick={onSend}
              >
                <IconSendOutline14 size={14} />
                {t('drafts.send')}
              </button>
              <button type="button" className={css.ghostBtn} onClick={onClear}>{t('drafts.clear')}</button>
            </div>
          </div>
          <ul className={css.draftList}>
            {drafts.map((draft, index) => (
              <li key={`${draft.path}-${draft.editSeq}-${draft.hunkIndex}-${draft.side}-${draft.lineIndex}`} className={css.draftItem}>
                <div className={css.draftAnchor} title={draftAnchorLabel(draft, 120)}>{draftAnchorLabel(draft)}</div>
                <div className={css.draftComment}>{draft.comment}</div>
                <button
                  type="button"
                  className={css.iconBtn}
                  title={t('action.remove')}
                  aria-label={t('action.remove')}
                  onClick={() => { onRemove(index) }}
                >
                  <IconTrashOutline16 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {sendState === 'sending' && <div className={css.draftsNote}>{t('drafts.send') }…</div>}
      {sendState === 'sent' && <div className={css.draftsNote}>{t('drafts.sent', { n: sentCount })}</div>}
      {sendState === 'failed' && <div className={css.draftsNoteError}>{t('drafts.sendFailed')}</div>}
    </div>
  )
}
