import './chrome.css'
import type { ClientContext } from './types.ts'
import { createTitleband } from './Titleband.tsx'

export const inject = ['slots', 'layout', 'workspaces']

export function apply(ctx: ClientContext): void {
  const host = window.dshDesktop
  document.documentElement.dataset.dshDesktop = ''
  if (host?.platform !== undefined && host.platform !== '') {
    document.documentElement.dataset.dshPlatform = host.platform
  }

  const DesktopTitleband = createTitleband({
    toggleSidebar: () => {
      ctx.layout.toggleSidebar()
    },
    startSession: () => {
      ctx.workspaces.startSession()
    },
    togglePanel: () => {
      ctx.layout.togglePanel()
    },
    // 放大语义矩阵收拢成一个无状态动作：面板关 → openPanel + 放大（两连）；
    // 面板开 → 翻转放大/恢复。openPanel 对已开面板保持原宽，togglePanelExpanded
    // 只在面板开时生效（0006 store 守卫），组合对三种初态都落到正确终态。
    togglePanelExpand: () => {
      ctx.layout.openPanel()
      ctx.layout.togglePanelExpanded()
    },
  })

  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'desktop-frame', order: 0 }, DesktopTitleband),
    )
  }, 'desktop-frame: titleband')
}
