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
 *
 * 服务面在注册表之上挂载聚焦动作（openPage/inspect，PanelShellFocus）：
 * inspect 是 0008 缝（ui-chat 的 inspectCall 可选探测）的生产侧——
 * chat 的 Inspect 按钮经它完成「开面板列 → 开轨迹页 → 下发一次性选中
 * 目标」的跨缝手势，交接 store 由容器订阅后经 owner props 送进面板页。
 */
import type { ClientContext, PanelShellFocus } from './types.ts'
import { PanelShell } from './PanelShell.tsx'
import { PanelShellController, reconcilePageHalves } from './registry.ts'
import { createInspectHandoff, createPanelLedger } from './panel-store.ts'
import { en, NS, zh } from './locales.ts'
import { registerTrajectoryPanel } from './trajectory.tsx'

// Contract exports only: page plugins type their registration halves
// against these (runtime access rides the ctx.panelShell service).
export { PanelShellController, reconcilePageHalves } from './registry.ts'
export type { PanelPageMeta } from './registry.ts'
export type { PanelPageOwnerProps, PanelShellComponentProps, PanelShellFocus } from './types.ts'
export { createInspectHandoff, createPanelLedger } from './panel-store.ts'
export type { InspectHandoff, InspectHandoffState, PanelLedger } from './panel-store.ts'
export { useHorizontalTabScroll } from './horizontal-tab-scroll.ts'

/** Core services only; trajectory is an optional page contributor. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Client plugin body: provide `ctx.panelShell`, occupy the `panel` column
 * and declare the page seam's slot inside the same registration.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const registry = new PanelShellController()
  const ledger = createPanelLedger()
  const handoff = createInspectHandoff()

  // 聚焦动作面：同一实例上挂载（服务身份不变，registerPage 消费者无感）。
  // inspect 的三步在同一同步手势里完成——openPanel/openPage/request 经 React
  // 批处理后一次 commit，页面 seat 可见后 TrajectoryView 的滚动 effect 才跑
  // （display:none 下 scrollIntoView 无效）。页面未注册时整体丢弃，避免写出
  // 无人认领的悬挂目标；但静默丢弃会让半坏的插件安装（元数据半注册失败）
  // 完全无迹可循，留一条警告。交接目标带 pageId 归属，下发时定向投递。
  const service = registry as PanelShellController & PanelShellFocus
  service.openPage = (id) => { ledger.openPage(id) }
  service.inspect = (pageId, callId) => {
    if (registry.page(pageId) === undefined) {
      console.warn(`panel-shell: inspect dropped — page "${pageId}" is not registered`)
      return
    }
    ctx.layout.openPanel()
    ledger.openPage(pageId)
    handoff.request(pageId, callId)
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'panel-shell: dictionaries')

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
    inject: () => ({ registry, ledger, handoff }),
    locale: NS,
  }, PanelShell))

  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('panelShell', service)


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
    let stopped = false
    let queued = false
    const scheduleReconcile = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!stopped) reconcile()
      })
    }
    const disposeRegistryWatch = registry.subscribe(scheduleReconcile)
    const disposeSlotWatch = ctx.slots.subscribe('panel-shell.page', scheduleReconcile)
    reconcile()

    return () => {
      stopped = true
      disposeSlotWatch()
      disposeRegistryWatch()
      void disposeService()
    }
  }, 'panel-shell: service + reconciliation watcher')


  ctx.inject(['trajectoryView'], (scope) => {
    scope.slots.inject('panel-shell.page', () => registerTrajectoryPanel(scope, registry, scope.trajectoryView))
  })

}
