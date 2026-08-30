export interface ClientContext {
  effect: (fn: () => void | (() => void), name?: string) => void
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (opts: { name: string; id: string; order?: number }, component: unknown) => unknown
  }
  layout: { toggleSidebar: () => void }
  workspaces: { startSession: (workspaceId?: string) => void }
}

declare global {
  interface Window {
    dshDesktop?: { platform?: string; dev?: boolean }
  }
}
