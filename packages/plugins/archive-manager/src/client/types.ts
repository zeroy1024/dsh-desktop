/**
 * 本地结构化契约：只镜像本插件触碰的公开服务/槽位面，不 import upstream src。
 * 运行时数据仍由官方 client runtime 拥有；slot 渲染器在渲染时注入
 * useWorkspaces / useSessions 座位 hook（GlobalStandardProps），勿自行 import。
 */

export type SessionId = string

/** wire 形状 WorkspaceView 的触及子集。 */
export interface WorkspaceView {
  workspaceId: string
  title: string
  /** 归档不移除会话的归属槽位，恢复后位置因此得以保留。 */
  sessionIds: readonly SessionId[]
}

/** 客户端 workspaces store 快照的触及子集。 */
export interface WorkspaceListState {
  items: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
}

/** 客户端 sessions store 行的触及子集（title 已由 host 投影，含 fallback 链）。 */
export interface SessionRow {
  id: SessionId
  displayTitle: string
  /** epoch 毫秒。 */
  updatedAt: number
}

/** 客户端 sessions store 快照的触及子集。 */
export interface SessionListState {
  byId: Readonly<Record<SessionId, SessionRow>>
}

/** 归档时间侧车快照：sessionId → 归档时刻（epoch 毫秒）。 */
export type ArchiveTimestampMap = Readonly<Record<string, number>>

/** 排序字段：归档时间或会话最后活跃时间。 */
export type SortField = 'archivedAt' | 'updatedAt'

/** 排序方向。 */
export type SortDirection = 'asc' | 'desc'

/** 官方快照 selector hook 座位的形态（uSES 风格）。 */
export type SnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S) => S

/** 官方 locale 翻译函数形态（{name} 占位由实现替换）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** slots.register 针对 'settings.section'（list 槽）的触及 options 子集。 */
export interface SectionRegisterOptions {
  name: 'settings.section'
  id: string
  order?: number
  label: string | (() => string)
  locale?: string
}

/** slots.register 的宽松返回：卸载 disposer。 */
type Register = (
  options: SectionRegisterOptions | { name: 'settings.section.icon'; key: string },
  component: unknown,
) => () => void

export interface SlotsRuntime {
  /** 等目标槽声明存在后执行工厂；声明塌缩时自动回收。 */
  inject: (name: string, factory: () => unknown) => unknown
  register: Register
}

export interface LocaleRuntime {
  register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => () => void
  bind: (namespace: string) => Translate
}

export interface ClientContext {
  effect: (factory: () => void | (() => void), name?: string) => unknown
  locale: LocaleRuntime
  slots: SlotsRuntime
}

/** section 组件 props：owner 面（close）+ locale 合成的 t + 全局座位 hook。 */
export interface ArchiveManagerSectionProps {
  close: () => void
  t: Translate
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  useSessions: SnapshotSelectorHook<SessionListState>
}
