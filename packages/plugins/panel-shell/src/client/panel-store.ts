/**
 * 面板容器的 tab 账本：打开 tab 集合 + 激活页 id，整值持久化
 * （`dsh.panel.shell.v1`，全局 key——面板开合与 tab 集合跨会话有意义，
 * 会话切换不重置）。容器经 inject 自持该账本而非框架的 store 座位：
 * `panel` 是 session-maybe 缝，无 current session 时渲染器不注入 store
 * 实例，而面板框架（tab 条与空态）必须两种相位都可用。页面内容状态归
 * 页面自持；账本只记「开了哪些、哪个激活」。每次 apply 新建实例——
 * 模块级句柄会把身份钉进模块缓存（插件重载后存活的准单例）。
 *
 * 同文件还承载跨缝 inspect 交接 store（createInspectHandoff）：0008 缝
 * 手势的状态半，容器订阅后经 owner props 下发（PanelShell.tsx）。
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
 * 跨缝 inspect 交接状态（一次性手势目标）：chat 侧 Inspect 按钮 → 面板页的
 * 选中请求。定向单槽：pageId 标记目标归属（容器下发时只投递给匹配的页面
 * 座位，其余座位显式收到 null），callId 为待认领的一次性目标；pageId 与
 * callId 同步写、同步清，永远同空同非空。非空即待认领；页面 resolve 成功
 * （或确认无解）后经 ack 清空，容器自身不做超时清理——目标记录可能尚未
 * 从历史分页中加载出来（上游 TrajectoryTable 的 pending 重试语义依赖它
 * 留存）。
 */
export type InspectHandoffState = {
  /** 目标归属的面板页 id；null = 空闲（callId 同步为 null）。 */
  pageId: string | null
  /** 待面板页认领的一次性 callId 目标。 */
  callId: string | null
}

/**
 * Observable inspect 交接 store 加完整写集。不持久化：一次性手势目标，
 * 刷新后丢失无碍。
 */
export type InspectHandoff = Omit<SnapshotStore<InspectHandoffState>, 'subscribe' | 'getSnapshot'> & {
  /** Property-arrow signatures: safe to pass unbound (useSyncExternalStore). */
  subscribe: (fn: () => void) => () => void
  getSnapshot: () => InspectHandoffState
  /** 写入（覆盖）一次定向目标；覆盖即「最新手势赢」。 */
  request: (pageId: string, callId: string) => void
  /** 页面 ack 后清空；空闲时静默（不发无谓的渲染信号）。 */
  clear: () => void
  /** 页面 tab 关闭时调用：悬挂目标属于该页则清空（其余页目标不受影响）。 */
  clearFor: (pageId: string) => void
}

/**
 * Create the inspect-handoff handle.
 * @returns the handoff (observable state + actions in one).
 */
export function createInspectHandoff(): InspectHandoff {
  const store = createSnapshotStore<InspectHandoffState>({ pageId: null, callId: null })
  const clear = (): void => {
    if (store.getSnapshot().callId === null) return
    store.update((d) => { d.pageId = null; d.callId = null })
  }
  return {
    ...store,
    subscribe: fn => store.subscribe(fn),
    getSnapshot: () => store.getSnapshot(),
    request: (pageId, callId) => {
      const current = store.getSnapshot()
      if (current.pageId === pageId && current.callId === callId) return
      store.update((d) => { d.pageId = pageId; d.callId = callId })
    },
    clear,
    clearFor: (pageId) => {
      if (store.getSnapshot().pageId !== pageId) return
      clear()
    },
  }
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
