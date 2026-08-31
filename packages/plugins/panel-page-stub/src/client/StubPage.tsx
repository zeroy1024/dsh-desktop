/**
 * StubPage: the panel protocol's living documentation and diagnostics page.
 * Exercises every owner-contract field — `active` flips (logged), the
 * session kit (sessionId), the badge callback (interactive demo) — and
 * renders the registered page list, so a broken panel assembly is visible
 * in the panel itself rather than only in tests.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PanelStubComponentProps } from './types.ts'
import css from './StubPage.module.css'

/**
 * Render the protocol diagnostics page.
 * @param props - composed slot props (see {@link PanelStubComponentProps}).
 * @returns the stub page element tree.
 */
export function StubPage({ active, sessionId, registry, bumpBadge, t }: PanelStubComponentProps) {
  // Kit re-reads and page-list changes both flow through the registry version.
  useSyncExternalStore(registry.subscribe, registry.getVersion)

  // Active-flip log: the page's own record of the container's visibility
  // contract (mounted-but-inactive seats keep rendering history here).
  const [flips, setFlips] = useState<string[]>([])
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      setFlips([active ? 'onActivate (mount)' : 'mounted inactive'])
      return
    }
    setFlips(previous => [...previous, active ? 'onActivate' : 'onDeactivate'])
  }, [active])

  return (
    <div className={css.root}>
      <h2 className={css.title}>{t('page.title')}</h2>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.kit')}</h3>
        <dl className={css.kit}>
          <dt>{t('kit.sessionId')}</dt>
          <dd className={css.code}>{sessionId}</dd>
          <dt>{t('kit.active')}</dt>
          <dd>{active ? t('kit.active.yes') : t('kit.active.no')}</dd>
        </dl>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.lifecycle')}</h3>
        {flips.length === 0
          ? <p className={css.dim}>{t('lifecycle.empty')}</p>
          : (
              <ul className={css.flipLog}>
                {flips.map((flip, index) => <li key={`${flip}-${index}`}>{flip}</li>)}
              </ul>
            )}
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.badge')}</h3>
        <div className={css.badgeRow}>
          <button type="button" className={css.badgeButton} onClick={() => { bumpBadge(1) }}>{t('badge.increase')}</button>
          <button type="button" className={css.badgeButton} onClick={() => { bumpBadge(-1) }}>{t('badge.decrease')}</button>
        </div>
        <p className={css.dim}>{t('badge.none')}</p>
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.pages')}</h3>
        <ul className={css.pageList}>
          {registry.pages.map(meta => (
            <li key={meta.id}>
              {meta.icon}
              <span className={css.pageId}>{meta.id}</span>
              <span className={css.dim}>{meta.title()}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
