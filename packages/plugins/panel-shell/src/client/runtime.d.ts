/**
 * 运行时外部模块声明：createSnapshotStore 由浏览器端的加载器模块表提供
 * （plugin-kit PRELOADED_CLIENT_EXTERNALS 预加载基线），bundle 时是
 * external，运行时解析到宿主的 runtime client 实例。上游权威定义：
 * upstream/packages/client/runtime/src/client/contract/store.ts（此处按
 * panel-store 实际触碰的面结构化镜像）。
 */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** Minimal observable snapshot source. */
  export interface ObservableSnapshot<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }

  /** Writable snapshot store (bare data face). */
  export interface SnapshotStore<T> extends ObservableSnapshot<T> {
    /** Mutate the state through an immer draft. */
    update(mutator: (draft: T) => void): void
    /** Replace the state wholesale. */
    set(next: T): void
  }

  /**
   * Create a snapshot store. Flush default is 'sync'; opt-in persistence
   * whole-value-JSONs the state into localStorage keyed by name.
   */
  export function createSnapshotStore<T>(
    init: T,
    opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } },
  ): SnapshotStore<T>
}
