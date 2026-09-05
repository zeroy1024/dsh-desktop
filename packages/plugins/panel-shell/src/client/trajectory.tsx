/** Adapt the upstream reusable trajectory contribution to our panel page. */
import { createElement, type ComponentProps } from 'react'
import type { TrajectoryViewFactory } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext, PanelPageOwnerProps } from './types.ts'
import type { PanelShellController } from './registry.ts'

export type TrajectoryContribution = ReturnType<TrajectoryViewFactory['create']>
export type TrajectoryViewService = TrajectoryViewFactory

/** The returned cleanup restores the native tab when the panel host leaves. */
export function registerTrajectoryPanel(ctx: ClientContext, registry: PanelShellController, view: TrajectoryViewService): () => void {
  const contribution = view.create()
  const Component = contribution.component
  // Create the adapter once per registration so Session switches and inspect
  // requests do not remount the upstream view and lose its scroll position.
  function PanelTrajectoryView({ inspect, onInspectDone, ...props }: Omit<ComponentProps<typeof Component>, 'viewRequest' | 'completeViewRequest' | 'openView'> & Pick<PanelPageOwnerProps, 'inspect' | 'onInspectDone'>) {
    return createElement(Component, {
      ...props,
      viewRequest: inspect ? { view: 'trajectory', focus: inspect.callId } : null,
      completeViewRequest: () => { onInspectDone?.() },
      openView: () => {},
    })
  }
  view.setDefaultEnabled(false)
  let disposeMeta: (() => void) | undefined
  let disposeSlot: (() => void) | undefined
  try {
    disposeMeta = registry.registerPage({
      id: 'trajectory', title: contribution.options.label, order: 10,
      icon: createElement(IconDataOutline16, { size: 16 }), sessionMode: 'required',
    })
    disposeSlot = ctx.slots.register({
      ...contribution.options, name: 'panel-shell.page',
    }, PanelTrajectoryView)
  } catch (error) {
    disposeSlot?.(); disposeMeta?.(); view.setDefaultEnabled(true)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeSlot?.(); disposeMeta?.(); view.setDefaultEnabled(true)
  }
}
