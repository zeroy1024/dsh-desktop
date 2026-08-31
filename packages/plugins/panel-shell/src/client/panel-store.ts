/**
 * 面板容器的 tab 账本：打开 tab 集合 + 激活页 id，整值持久化
 * （`dsh.panel.shell.v1`，全局 key——面板开合与 tab 集合跨会话有意义，
 * 会话切换不重置）。容器经 inject 自持该账本而非框架的 store 座位：
 * `panel` 是 session-maybe 缝，无 current session 时渲染器不注入 store
 * 实例，而面板框架（tab 条与空态）必须两种相位都可用。页面内容状态归
 * 页面自持；账本只记「开了哪些、哪个激活」。每次 apply 新建实例——
 * 模块级句柄会把身份钉进模块缓存（插件重载后存活的准单例）。
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Panel container tab-ledger state, persisted as a whole value. */
type PanelLedgerState = {
  /** Open tab ids in open order; empty means the panel shows its guide. */
  openTabs: readonly string[]
  /** The active tab id; null when no tab is open (or the active page left). */
  activeId: string | null
}

/** Observable ledger plus the complete write set (the container's actions). */
export type PanelLedger = Omit<SnapshotStore<PanelLedgerState>, 'subscribe' | 'getSnapshot'> & {
  /** Property-arrow signatures: safe to pass unbound (useSyncExternalStore). */
  subscribe: (fn: () => void) => () => void
  getSnapshot: () => PanelLedgerState
  /** Open a page: append its tab when missing, then activate it. */
  openPage: (id: string) => void
  /** Close a page's tab; closing the active tab activates the last remaining one. */
  closePage: (id: string) => void
  /** Activate an open tab (no-op for an id that is not open). */
  setActive: (id: string) => void
}

/**
 * Create the panel tab-ledger handle.
 * @returns the ledger (observable state + actions in one).
 */
export function createPanelLedger(): PanelLedger {
  const store = createSnapshotStore<PanelLedgerState>(
    { openTabs: [], activeId: null },
    { persist: { name: 'dsh.panel.shell.v1' } },
  )
  return {
    ...store,
    subscribe: fn => store.subscribe(fn),
    getSnapshot: () => store.getSnapshot(),
    openPage: (id) => {
      store.update((d) => {
        d.openTabs = d.openTabs.includes(id) ? d.openTabs : [...d.openTabs, id]
        d.activeId = id
      })
    },
    closePage: (id) => {
      store.update((d) => {
        if (!d.openTabs.includes(id)) return
        const rest = d.openTabs.filter(tab => tab !== id)
        d.openTabs = rest
        if (d.activeId === id) d.activeId = rest.at(-1) ?? null
      })
    },
    setActive: (id) => {
      store.update((d) => {
        if (d.openTabs.includes(id)) d.activeId = id
      })
    },
  }
}
