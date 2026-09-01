/**
 * The settings-card chrome used by the upstream ui-settings-plugins section.
 *
 * This is intentionally a source-level mirror rather than a runtime import of
 * the upstream component.  The desktop plugin is bundled independently, but
 * its card must keep the same DOM and visual contract as the stock cards.
 */

import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardShell } from './card-form.ts'
import css from './PluginCard.module.css'

export interface PluginCardProps {
  /** Locale reader for the card's copy. */
  t: (key: string) => string
  /** Already-localized card title. */
  title: string
  /** Already-localized card description. */
  description: string
  /** Card form state. */
  state: CardShell
  /** Persist all staged edits. */
  onSave: () => void
  /** Drop all staged edits. */
  onDiscard: () => void
  /** Card controls. */
  children: ReactNode
}

/** Render one settings card with the upstream PluginCard DOM contract. */
export function PluginCard(props: PluginCardProps) {
  const [open, setOpen] = useState(false)
  const { state } = props
  if (!state.available) return null

  // Keep this decision in the card shell, as upstream does: a read-only
  // settings document can still contain a writable credentials control.
  const blocked = !state.dirty || state.invalid || state.saving

  return (
    <li className={`${css.card}${open ? ` ${css.cardOpen}` : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${props.title}`}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{props.title}</span>
          <span className={css.description}>{props.description}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{props.t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{props.t('readOnly')}</p> : null}
            {props.children}
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{props.t('saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={props.onDiscard}
              >
                {props.t('discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={blocked}
                onClick={props.onSave}
              >
                {props.t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
