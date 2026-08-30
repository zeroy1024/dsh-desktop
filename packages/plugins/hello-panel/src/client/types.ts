/**
 * 最小 ClientContext 形状。不 import 上游 src / vendor 类型，避免 P2 把
 * dsh 包拉进我们的 workspace 依赖图；运行时对象由 loader 注入。
 */
export interface ClientContext {
  effect: (fn: () => void | (() => void), name?: string) => void
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (opts: { name: string; id: string; order?: number }, component: unknown) => unknown
  }
}
