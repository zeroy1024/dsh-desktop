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
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconCloseFill14, IconPlusOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelShellComponentProps } from './types.ts'
import type { PanelPageMeta } from './registry.ts'
import { isPageVisible, resolveVisibleActiveId } from './registry.ts'
import { useHorizontalTabScroll } from './horizontal-tab-scroll.ts'
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
// The frame owns the grid width and re-renders on every drag/transition tick.
// All panel inputs are stable services or primitive session/locale values, and
// the stores below subscribe independently, so memoizing this boundary keeps a
// layout tick from rebuilding the tab list and every persistent page seat.
export const PanelShell = memo(function PanelShell({ ledger, handoff, renderSlot, registry, t, sessionId }: PanelShellComponentProps) {
  // The ledger is container-owned (injected), not the framework store seat:
  // `panel` is session-maybe and the renderer withholds store instances while
  // no session is current, but the tab strip must work in both phases.
  const { openTabs, activeId } = useSyncExternalStore(ledger.subscribe, ledger.getSnapshot)
  // 跨缝 inspect 交接（0008 缝的消费侧）：定向单槽——owner props 只投递给
  // pageId 匹配的页面座位（slot 组装里 owner 最后摊开、优先级最高），其余
  // 座位显式收到 null，杜绝多页面下的广播误伤。ack 取 store 动作本体（引用
  // 稳定，配合上游 effect 的依赖数组语义）。
  const inspection = useSyncExternalStore(handoff.subscribe, handoff.getSnapshot)
  // Tab strip follows metadata registration, badge notifications, and
  // reconciliation results: one version counter covers all three.
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getVersion)

  // 会话相位过滤：sessionMode:'required' 的页在无会话时从 tab 条与「+」菜单
  // 整条隐身；账本（openTabs/activeId）不动——会话回来按钮自动复现。若当前
  // active 页被过滤，则只在呈现层临时回退到首个可见页，避免空白面板。
  const hasSession = sessionId !== undefined && sessionId !== ''
  const available = registry.pages.filter(meta =>
    !openTabs.includes(meta.id) && isPageVisible(meta, hasSession))
  const openMetas: Array<{ id: string; meta: PanelPageMeta }> = []
  for (const id of openTabs) {
    const meta = registry.page(id)
    /* v8 ignore next -- a deregistered id is pruned by the reconciliation watcher. */
    if (meta !== undefined && isPageVisible(meta, hasSession)) openMetas.push({ id, meta })
  }
  const visibleActiveId = resolveVisibleActiveId(openMetas.map(entry => entry.id), activeId)

  // Page visibility edges: fire onDeactivate on the previously active page
  // and onActivate on the newly active one. The ref seed (null) makes the
  // first render fire onActivate for a restored active tab after reload.
  const prevActive = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevActive.current
    if (prev === visibleActiveId) return
    if (prev !== null) registry.page(prev)?.onDeactivate?.()
    if (visibleActiveId !== null) registry.page(visibleActiveId)?.onActivate?.()
    prevActive.current = visibleActiveId
  }, [registry, visibleActiveId])

  const [menuOpen, setMenuOpen] = useState(false)
  // Registry shrinkage (a page plugin uninstalled) closes the orphaned tabs:
  // the tab strip is the mount contract, so a deregistered page's tab (and
  // its mounted seat) goes with it, and the active fallback rides closePage.
  // The version rides the deps so every registry change re-runs the sweep.
  // Tab 关闭连带清悬挂：该页名下尚未 ack 的 inspect 目标随之作废（页面插件
  // 卸载 / 用户关 tab 都不会留下幽灵目标），其余页目标不受影响。
  const closePage = useCallback((id: string): void => {
    ledger.closePage(id)
    handoff.clearFor(id)
  }, [ledger, handoff])
  useEffect(() => {
    for (const id of openTabs) {
      if (registry.page(id) === undefined) closePage(id)
    }
  }, [closePage, openTabs, registry, registryVersion])
  // Opening keeps page order stable (append at the tail) and activates.
  const openPage = (id: string): void => {
    ledger.openPage(id)
    setMenuOpen(false)
  }
  const error = registry.reconcileError
  const tabsRef = useHorizontalTabScroll<HTMLDivElement>(visibleActiveId, openMetas.length)

  return (
    <div className={css.root}>
      <header className={css.header}>
        {openMetas.length > 0 && (
          <>
            <div ref={tabsRef} className={css.tabs} role="tablist" aria-label={t('tabs.aria')}>
              {openMetas.map(({ id, meta }) => {
                const active = id === visibleActiveId
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
                      onClick={() => { closePage(id) }}
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

      {openMetas.length === 0
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
            <div key={id} className={cx(css.seat, id !== visibleActiveId && css.seatHidden)} data-panel-page-seat={id}>
              {renderSlot('panel-shell.page', {
                active: id === visibleActiveId,
                inspect: inspection.pageId === id && inspection.callId !== null
                  ? { callId: inspection.callId }
                  : null,
                onInspectDone: handoff.clear,
              }, { only: id })}
            </div>
          ))}
    </div>
  )
})
