/**
 * 本地结构化契约：只镜像本插件触碰的公开服务/槽位面，不 import upstream src。
 * 运行时目录实例仍由官方 ui-model-selection 的 modelDirectories 服务拥有。
 */

export type SessionId = string

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelReasoning {
  efforts: readonly ModelReasoningEffort[]
  defaultEffort?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: readonly ModelCatalogModel[]
}

export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** 官方 ModelDirectory.store 的可观察快照。 */
export interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
}

export interface SnapshotStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

export type SnapshotSelectorHook<T> = <S>(
  selector: (snapshot: T) => S,
  equal?: (previous: S, next: S) => boolean,
) => S

export interface ModelDirectory {
  readonly store: SnapshotStore<ModelDirectoryState>
  load: () => Promise<SessionModels>
  select: (selection: ModelSelection) => Promise<void>
}

export interface ModelDirectoryResolver {
  directoryFor: (sessionId: SessionId) => ModelDirectory
}

export interface SessionRuntime {
  subagentAddress: (sessionId: SessionId) => unknown
}

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 注册项 inject.face；hooks 会被渲染器自动变成 useModelDirectory。 */
export interface ModelSelectInjectFace {
  available: boolean
  load: () => void
  select: (selection: ModelSelection) => Promise<boolean>
  getError: () => string | null
  hooks: {
    modelDirectory: SnapshotStore<ModelDirectoryState>
  }
}

/** 渲染器绑定 inject.hooks 后交给组件的 props。 */
export interface ModelSelectProps {
  locked: boolean
  available: boolean
  load: () => void
  select: (selection: ModelSelection) => Promise<boolean>
  getError: () => string | null
  useModelDirectory: SnapshotSelectorHook<ModelDirectoryState>
  t: Translate
}

export interface LocaleRuntime {
  register: (
    namespace: string,
    dictionaries: Record<string, Record<string, string>>,
  ) => () => void
}

export interface ModelSelectionSlots {
  inject: (name: string, factory: () => unknown) => unknown
  register: (
    options: {
      name: string
      priority?: number
      locale?: string
      inject?: (sessionId: SessionId) => ModelSelectInjectFace
    },
    component: unknown,
  ) => () => void
}

export interface ModelSelectionScope {
  slots: ModelSelectionSlots
  modelDirectories: ModelDirectoryResolver
  sessions: SessionRuntime
}

export interface ClientContext {
  effect: (fn: () => void | (() => void), name?: string) => unknown
  inject: (
    services: readonly string[],
    callback: (scope: ModelSelectionScope) => unknown,
  ) => unknown
  locale: LocaleRuntime
  slots: ModelSelectionSlots
}
