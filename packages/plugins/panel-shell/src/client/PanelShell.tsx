/**
 * PanelShell: the side-panel container occupying ui-layout's `panel` column
 * (the seam is introduced by patches/0006-ui-layout-panel-seam.patch). Owns
 * the tab strip (open tabs from the container store, labels/icons/badges
 * from the metadata registry), the "+" add-page menu, the per-tab page seats
 * (one persistent mount per open tab; switching tabs flips `active` and
 * visibility, never unmounts), and the empty-state guide. The fork's
 * `data-titleband-region` header marker is dropped: our desktop-frame
 * titleband is an overlay that never covers the right column.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconCloseFill14, IconPlusOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelShellComponentProps } from './types.ts'
import type { PanelPageMeta } from './registry.ts'
import css from './PanelShell.module.css'

/** Join optional hashed class names (the fork uses clsx; we stay dependency-free). */
function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ')
}

/**
 * Render the side-panel container.
 * @param props - composed slot props (see {@link PanelShellComponentProps}).
 * @returns the panel element tree.
 */
export function PanelShell({ ledger, renderSlot, registry, t }: PanelShellComponentProps) {
  // The ledger is container-owned (injected), not the framework store seat:
  // `panel` is session-maybe and the renderer withholds store instances while
  // no session is current, but the tab strip must work in both phases.
  const { openTabs, activeId } = useSyncExternalStore(ledger.subscribe, ledger.getSnapshot)
  // Tab strip follows metadata registration, badge notifications, and
  // reconciliation results: one version counter covers all three.
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion)

  // Page visibility edges: fire onDeactivate on the previously active page
  // and onActivate on the newly active one. The ref seed (null) makes the
  // first render fire onActivate for a restored active tab after reload.
  const prevActive = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActive.current
    if (prev === activeId) return
    if (prev !== null) registry.page(prev)?.onDeactivate?.()
    if (activeId !== null) registry.page(activeId)?.onActivate?.()
    prevActive.current = activeId
  }, [activeId, registry])

  const [menuOpen, setMenuOpen] = useState(false)
  // Registry shrinkage (a page plugin uninstalled) closes the orphaned tabs:
  // the tab strip is the mount contract, so a deregistered page's tab (and
  // its mounted seat) goes with it, and the active fallback rides closePage.
  // The version rides the deps so every registry change re-runs the sweep.
  useEffect(() => {
    for (const id of openTabs) {
      if (registry.page(id) === undefined) ledger.closePage(id)
    }
  }, [ledger, openTabs, registry, registryVersion])
  // Opening keeps page order stable (append at the tail) and activates.
  const openPage = (id: string): void => {
    ledger.openPage(id)
    setMenuOpen(false)
  }
  // The "+" menu and the empty-state guide list the same set: registered
  // pages whose tab is not open yet.
  const available = registry.pages.filter(meta => !openTabs.includes(meta.id))
  const openMetas: Array<{ id: string; meta: PanelPageMeta }> = []
  for (const id of openTabs) {
    const meta = registry.page(id)
    /* v8 ignore next -- a deregistered id is pruned by the reconciliation watcher. */
    if (meta !== undefined) openMetas.push({ id, meta })
  }
  const error = registry.reconcileError

  return (
    <div className={css.root}>
      <header className={css.header}>
        {openMetas.length > 0 && (
          <>
            <div className={css.tabs} role="tablist" aria-label={t('tabs.aria')}>
              {openMetas.map(({ id, meta }) => {
                const active = id === activeId
                const badge = meta.badge?.()
                return (
                  <div key={id} className={cx(css.tab, active && css.tabActive)} role="tab" aria-selected={active}>
                    <button
                      type="button"
                      className={css.tabButton}
                      tabIndex={active ? 0 : -1}
                      onClick={() => { ledger.setActive(id) }}
                    >
                      {meta.icon}
                      <span className={css.tabLabel}>{meta.title()}</span>
                      {badge !== undefined && badge > 0 && <span className={css.badge}>{badge}</span>}
                    </button>
                    <button
                      type="button"
                      className={css.tabClose}
                      aria-label={`${t('tab.close')}: ${meta.title()}`}
                      onClick={() => { ledger.closePage(id) }}
                    >
                      <IconCloseFill14 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
            {/* The add-page affordance belongs to a populated strip only: the
                empty state's guide list owns the no-tabs entry point, and the
                "+" hugs the last tab instead of the header's trailing edge. */}
            <div className={css.plusWrap}>
              <Menu
                open={menuOpen && available.length > 0}
                align="end"
                anchor={
                  <button
                    type="button"
                    className={css.plus}
                    aria-label={t('menu.open')}
                    disabled={available.length === 0}
                    onClick={() => { setMenuOpen(value => !value) }}
                  >
                    <IconPlusOutline16 size={16} />
                  </button>
                }
                items={available.map(meta => ({ id: meta.id, label: meta.title(), icon: meta.icon }))}
                onSelect={(id) => { openPage(id) }}
                onClose={() => { setMenuOpen(false) }}
                portal
              />
            </div>
          </>
        )}
      </header>

      {error !== null && <div className={css.error} role="alert">{error}</div>}

      {openTabs.length === 0
        ? (
            <div className={css.empty}>
              <p className={css.emptyTitle}>{t('empty.title')}</p>
              <p className={css.emptyGuide}>{available.length > 0 ? t('empty.guide') : t('empty.none')}</p>
              {available.length > 0 && (
                <div className={css.emptyPages}>
                  {available.map(meta => (
                    <button
                      key={meta.id}
                      type="button"
                      className={css.emptyPage}
                      onClick={() => { openPage(meta.id) }}
                    >
                      {meta.icon}
                      <span>{meta.title()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        : openMetas.map(({ id }) => (
            // One persistent seat per open tab: switching tabs flips `active`
            // and hides the seat — page state survives until the tab closes.
            <div key={id} className={cx(css.seat, id !== activeId && css.seatHidden)} data-panel-page-seat={id}>
              {renderSlot('panel-shell.page', { active: id === activeId }, { only: id })}
            </div>
          ))}
    </div>
  )
}
