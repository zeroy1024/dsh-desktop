import './chrome.css'
import type { ClientContext } from './types.ts'
import { createFrameLocaleStore } from './locales.ts'
import { createTitleband } from './Titleband.tsx'

export const inject = ['slots', 'layout', 'workspaces', 'locale', 'theme']

export function apply(ctx: ClientContext): void {
  const host = window.dshDesktop
  document.documentElement.dataset.dshDesktop = ''
  if (host?.platform !== undefined && host.platform !== '') {
    document.documentElement.dataset.dshPlatform = host.platform
  }

  // 窗框文案 store：locale/change（上游 locale 服务）驱动；Titleband 按钮
  // 文案与 ApplicationMenuBar 顶级标签都从这里取，避免每个组件各拉一份。
  const frameLocale = createFrameLocaleStore(() => ctx.locale.getLocale().active)
  ctx.effect(() => ctx.locale.subscribe(() => frameLocale.setLocale(ctx.locale.getLocale().active)),
    'desktop-frame: locale adoption')

  // 主题偏好 → nativeTheme.themeSource（仅 Windows）：caption glyph、系统
  // popup 与 Mica 跟 WebUI 主题一致；system 发 system，其余按解析后的
  // colorScheme 发 light/dark。theme/change 幂等重发。
  const syncThemeSource = (): void => {
    if (host?.platform !== 'win32' || host.setNativeThemeSource === undefined) return
    const theme = ctx.theme.getTheme()
    const source = theme.preference === 'system' ? 'system' : theme.active.colorScheme
    void host.setNativeThemeSource(source).catch(() => {
      // 主进程未装配（非 Windows 运行时）时静默忽略
    })
  }
  ctx.effect(() => {
    syncThemeSource()
    return ctx.on('theme/change', syncThemeSource)
  }, 'desktop-frame: native theme sync')

  // 外观快照（Mica/实底回退、forced colors、减少透明度）→ dataset；CSS
  // 据此选材质 wash 或实底。仅在 Windows 装配（无快照时保持未标记）。
  const syncAppearance = (): void => {
    void host?.getAppearance?.().then((snapshot) => {
      if (snapshot === null || snapshot === undefined) return
      const root = document.documentElement
      root.dataset.dshBackdrop = snapshot.backdrop
      root.dataset.dshReducedTransparency = snapshot.reducedTransparency ? 'true' : 'false'
      root.dataset.dshForcedColors = snapshot.forcedColors ? 'true' : 'false'
    }).catch(() => {
      // 主进程未装配或窗口已销毁：保持未标记，CSS 按实底兜底
    })
  }
  ctx.effect(() => {
    syncAppearance()
    return host?.onAppearanceChanged?.(() => { syncAppearance() }) ?? ((): void => {})
  }, 'desktop-frame: appearance adoption')

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
    frame: frameLocale,
  })

  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'desktop-frame', order: 0 }, DesktopTitleband),
    )
  }, 'desktop-frame: titleband')
}