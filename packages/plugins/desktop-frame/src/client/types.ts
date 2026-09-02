export interface ClientContext {
  effect: (fn: () => void | (() => void), name?: string) => void
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (opts: { name: string; id: string; order?: number }, component: unknown) => unknown
  }
  layout: {
    toggleSidebar: () => void
    togglePanel: () => void
    togglePanelExpanded: () => void
  }
  workspaces: { startSession: (workspaceId?: string) => void }
}

declare global {
  interface Window {
    dshDesktop?: { platform?: string; dev?: boolean }
  }

  /** Windows WCO（titleBarOverlay）几何：系统窗口按钮占用的标题栏矩形。 */
  interface Navigator {
    readonly windowControlsOverlay?: {
      getTitlebarAreaRect(): { x: number; width: number }
      addEventListener(
        type: 'geometrychange',
        listener: () => void,
        options?: AddEventListenerOptions,
      ): void
      removeEventListener(
        type: 'geometrychange',
        listener: () => void,
        options?: EventListenerOptions,
      ): void
    }
  }
}
