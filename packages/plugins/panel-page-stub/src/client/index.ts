/**
 * Panel stub page plugin, browser half: registers the `'stub'` diagnostics
 * page into `panel-shell.page` as one transactional effect — the metadata
 * half (`panelShell.registerPage`) and the slot-occupancy half register in
 * the same effect with a combined disposer, so the container's
 * reconciliation never observes one half alone from this plugin, and plugin
 * removal disposes both. 这是后续真面板页插件的最佳实践范本。
 */
import type { ClientContext } from './types.ts'
import { StubPage } from './StubPage.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'locale', 'panelShell']

// Apply-scope demo state: the badge counter and the lifecycle log live here
// (registration-time closures read them; the page mutates them through the
// inject face). Plain closures — diagnostics state is deliberately not a
// store; the registry version counter carries the re-render signal.
let demoBadge = 0

/**
 * Client plugin body: one inject call, two registration halves.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'panel-page-stub: dictionaries')
  // Registration-time text (the tab title) reads through the bound translate
  // as a thunk, so it follows the active locale without re-registration.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('panel-shell.page', () => {
    const disposeMeta = ctx.panelShell.registerPage({
      id: 'stub',
      title: () => t('page.title'),
      // Deliberate: no order — the stub sorts after every ordered page.
      badge: () => demoBadge > 0 ? demoBadge : undefined,
      // onActivate/onDeactivate 无独立演示必要：激活翻转已由 StubPage 组件
      // 内部经 active prop 记录日志（挂载不卸载语义的直接证据）。
    })
    const disposeSlot = ctx.slots.register({
      name: 'panel-shell.page',
      id: 'stub',
      locale: NS,
      inject: () => ({
        registry: ctx.panelShell,
        bumpBadge: (delta: number) => {
          demoBadge = Math.max(0, demoBadge + delta)
          ctx.panelShell.notifyBadgeChange()
        },
      }),
    }, StubPage)
    return () => {
      disposeSlot()
      disposeMeta()
    }
  })
}
