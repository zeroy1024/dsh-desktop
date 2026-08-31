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
  })

  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'desktop-frame', order: 0 }, DesktopTitleband),
    )
  }, 'desktop-frame: titleband')
}
