/**
 * 本地结构化类型契约：本插件消费的 ctx 面 + window.dshDesktop 桥面。
 * 常量引用上游权威定义（ui-theme/locale 的 ClientContext 是声明合并后的
 * Cordis Context），但按边界铁律不 import 上游 src——vendor tarball 又是
 * gitignore 的，因此逐字镜像插件实际触碰的类型面（panel-shell 同款先例）。
 */

/** 主进程外观快照（镜像 windows-appearance.ts 的 WindowsAppearanceSnapshot）。 */
export interface DesktopAppearanceSnapshot {
  backdrop: 'mica' | 'solid'
  dark: boolean
  forcedColors: boolean
  reducedTransparency: boolean
}

/** dshDesktop 桥面（镜像 apps/desktop/src/preload/index.ts 的暴露面）。 */
export interface DesktopBridge {
  platform?: string
  dev?: boolean
  showApplicationMenu?: (
    id: string,
    anchor: { x: number; y: number; width: number; height: number },
  ) => Promise<boolean>
  onApplicationMenuClosed?: (listener: (id: string) => void) => () => void
  getAppearance?: () => Promise<DesktopAppearanceSnapshot | null>
  onAppearanceChanged?: (listener: (snapshot: DesktopAppearanceSnapshot) => void) => () => void
  setNativeThemeSource?: (source: 'system' | 'light' | 'dark') => Promise<void>
}

/** 结构化 Cordis Context（上游是声明合并后的 ClientContext = Context）。 */
export interface ClientContext {
  layout: {
    toggleSidebar: () => void
    togglePanel: () => void
    togglePanelExpanded: () => void
  }
  workspaces: { startSession: (workspaceId?: string) => void }
  locale: {
    getLocale: () => { active: string }
    subscribe: (listener: () => void) => () => void
  }
  theme: {
    getTheme: () => {
      preference: 'system' | 'light' | 'dark'
      active: { colorScheme: 'light' | 'dark' }
    }
  }
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (opts: { name: string; id: string; order?: number }, component: unknown) => unknown
  }
  effect: (fn: () => void | (() => void), name?: string) => void
  /** 上游事件（'theme/change' / 'locale/change'）；返回注销函数。 */
  on: (event: string, listener: (data: unknown) => void) => () => void
}

declare global {
  interface Window {
    dshDesktop?: DesktopBridge
  }
}