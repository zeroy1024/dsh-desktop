/**
 * Panel-shell container plugin, browser half: provides the `panelShell`
 * metadata-registry service and occupies ui-layout's `panel` column (the
 * seam is introduced by patches/0006-ui-layout-panel-seam.patch), declaring
 * the `panel-shell.page` page seam in the same breath. An apply-side watcher
 * reconciles the two registration halves — metadata without a slot entry, or
 * the reverse — into a loud, user-visible error (never a silent skip).
 *
 * The fork's frame-toolbar toggle seat is dropped by design: our desktop
 * shell keeps its own titleband overlay (desktop-frame), whose panel button
 * drives the same ctx.layout actions.
 */
import type { ClientContext } from './types.ts'
import { PanelShell } from './PanelShell.tsx'
import { PanelShellController, reconcilePageHalves } from './registry.ts'
import { createPanelLedger } from './panel-store.ts'
import { en, NS, zh } from './locales.ts'

// Contract exports only: page plugins type their registration halves
// against these (runtime access rides the ctx.panelShell service).
export { PanelShellController, reconcilePageHalves } from './registry.ts'
export type { PanelPageMeta } from './registry.ts'
export type { PanelPageOwnerProps, PanelShellComponentProps } from './types.ts'
export { createPanelLedger } from './panel-store.ts'
export type { PanelLedger } from './panel-store.ts'

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: provide `ctx.panelShell`, occupy the `panel` column
 * and declare the page seam's slot inside the same registration.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const registry = new PanelShellController()
  const ledger = createPanelLedger()

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'panel-shell: dictionaries')

  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('panelShell', registry)

    // Reconciliation watcher: registry changes, slot-ledger changes, and the
    // initial state all re-run the pairing check. A mismatch seats a loud
    // error (the container renders it as an alert banner); a clean pass
    // clears it. Pruning deregistered pages' tabs is the container's fallback
    // problem and happens render-side (PanelShell owns the store actions
    // there).
    const reconcile = (): void => {
      const slotIds = new Set<string>()
      for (const entry of ctx.slots.entries('panel-shell.page')) {
        if (entry.options.id !== undefined) slotIds.add(entry.options.id)
      }
      registry.setReconcileError(reconcilePageHalves(registry.pages, slotIds))
    }
    const disposeRegistryWatch = registry.subscribe(reconcile)
    const disposeSlotWatch = ctx.slots.subscribe('panel-shell.page', reconcile)
    reconcile()

    return () => {
      disposeSlotWatch()
      disposeRegistryWatch()
      void disposeService()
    }
  }, 'panel-shell: service + reconciliation watcher')

  // The container: occupies the panel column and declares the page seam
  // (declaration = exclusive render authority). The tab ledger store rides
  // the inject face, not the framework store seat: the session-maybe scope
  // withholds store instances while no session is current, and the tab strip
  // must work in both phases.
  ctx.slots.inject('panel', () => ctx.slots.register({
    name: 'panel',
    children: {
      'panel-shell.page': { kind: 'list', scope: 'session' },
    },
    inject: () => ({ registry, ledger }),
    locale: NS,
  }, PanelShell))
}
