export interface ClientContext {
  effect: (fn: () => void | (() => void), name?: string) => void
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (opts: { name: string; id: string; order?: number }, component: unknown) => unknown
  }
}

export interface DshDesktop {
  dev?: boolean
}

declare global {
  interface Window {
    dshDesktop?: DshDesktop
  }
}
