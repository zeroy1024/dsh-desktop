import './chrome.css'
import type { ClientContext } from './types.ts'
import { createTitleband } from './Titleband.tsx'

export const inject = ['slots', 'layout', 'workspaces']

/**
 * Windows WCO（titleBarOverlay）让位：系统把最小化/最大化/关闭三键叠加在
 * 窗口右上角，而面板按钮簇钉在同一位置。把系统按钮条的宽度写入 CSS 变量
 * （chrome.css 用它把面板簇从右缘左移），窗口最大化/还原时几何会变，跟随
 * geometrychange 同步。非 win32 或宿主未启用 WCO 时不设置，簇保持贴右缘。
 */
function syncWindowControlsOverlayInset(): void {
  if (window.dshDesktop?.platform !== 'win32') return
  const overlay = navigator.windowControlsOverlay
  if (!overlay) return
  const syncGeometry = (): void => {
    document.documentElement.style.setProperty(
      '--dsh-wco-width',
      `${Math.round(overlay.getTitlebarAreaRect().width)}px`,
    )
  }
  syncGeometry()
  overlay.addEventListener('geometrychange', syncGeometry)
}

export function apply(ctx: ClientContext): void {
  const host = window.dshDesktop
  document.documentElement.dataset.dshDesktop = ''
  if (host?.platform !== undefined && host.platform !== '') {
    document.documentElement.dataset.dshPlatform = host.platform
  }
  syncWindowControlsOverlayInset()

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
    // 放大钮只在面板展开时渲染（Titleband 管），这里的动作只需翻转放大态：
    // togglePanelExpanded 自带 0006 store 守卫（面板关时不生效）。
    togglePanelExpand: () => {
      ctx.layout.togglePanelExpanded()
    },
  })

  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'desktop-frame', order: 0 }, DesktopTitleband),
    )
  }, 'desktop-frame: titleband')
}
