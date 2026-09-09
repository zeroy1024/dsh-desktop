import { useState } from 'react'
import { IconRefreshOutline14, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './types.ts'
import css from './ReviewPage.module.css'

/** Fixed-width controls keep the summary on one line at any panel width. */
export function SummaryActions({ sortMode, onSort, allReviewed, onToggleReviewed, onRefresh, t }: {
  sortMode: 'changes' | 'path'
  onSort: (mode: 'changes' | 'path') => void
  allReviewed: boolean
  onToggleReviewed: () => void
  onRefresh: () => void
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.summaryActions}>
      <Tooltip label={t('action.refresh')} side="bottom" delayMs={500}>
        <button type="button" className={css.summaryButton} aria-label={t('action.refresh')} onClick={onRefresh}>
          <IconRefreshOutline14 size={14} />
        </button>
      </Tooltip>
      <Menu
        open={open}
        align="end"
        portal
        anchor={(
          <Tooltip label={t('summary.actions')} side="bottom" delayMs={500}>
            <button type="button" className={css.summaryButton} aria-label={t('summary.actions')} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
              <span aria-hidden="true">⋯</span>
            </button>
          </Tooltip>
        )}
        items={[
          { id: 'changes', label: `${sortMode === 'changes' ? '✓ ' : ''}${t('summary.sortByChanges')}` },
          { id: 'path', label: `${sortMode === 'path' ? '✓ ' : ''}${t('summary.sortByPath')}` },
          { id: 'reviewed', label: t(allReviewed ? 'summary.unmarkAll' : 'summary.markAll') },
        ]}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'changes' || id === 'path') onSort(id)
          else if (id === 'reviewed') onToggleReviewed()
        }}
        onClose={() => { setOpen(false) }}
      />
    </div>
  )
}
