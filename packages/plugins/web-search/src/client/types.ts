import type { CredentialRemote } from './credentials.ts'
/**
 * Client-local structural mirrors of the public DSH browser contracts.
 *
 * The desktop plugin is built independently from the upstream web workspace;
 * keeping these types local avoids importing `upstream/src` (and keeps the
 * ModuleLoader bundle's dependency surface explicit).  The runtime objects are
 * still the official `settingsScope`, `connection`, `remote`, `locale`, and
 * `slots` services supplied by the composed web application.
 */

export type Translate = (key: string) => string

export interface SnapshotStore<T> {
  getSnapshot(): T
  set(snapshot: T): void
  subscribe(listener: () => void): () => void
}

export type SettingsScopeStatus = 'loading' | 'ready' | 'unavailable'

export interface SettingsScopeSnapshot<T> {
  status: SettingsScopeStatus
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

export interface SettingsScopeBinder {
  bind<T>(spec: { namespace: string }): SettingsScope<T>
  describe?(): unknown
}

export interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

export interface RpcSuccess<T> {
  ok: true
  value: T
}

export interface RpcFailure {
  ok: false
  error?: { code?: string; message?: string }
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure

export interface CredentialsApi {
  describe(request: { refs: string[] }): Promise<{
    result: RpcResult<{ credentials: Record<string, CredentialView> }>
  }>
  set(request: { ref: string; value: string }): Promise<{ result: RpcResult<Record<string, never>> }>
}

export interface ApiClient {
  credentials?: CredentialsApi
}

export interface ConnectionHandle {
  api: ApiClient
}

export interface RemoteEvents extends CredentialRemote {
  $on(event: 'credentials/reference-updated', listener: (ref: string) => void): () => void
}

export interface LocaleRuntime {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
}

export interface SlotRegistry {
  inject(name: string, factory: () => unknown): unknown
  register(options: {
    name: string
    key?: string
    locale?: string
    inject?: () => unknown
  }, component: unknown): unknown
}

export interface ClientContext {
  get(name: string): unknown
  effect(factory: () => void | (() => void | Promise<void>), name?: string): unknown
  locale: LocaleRuntime
  remote: RemoteEvents
  settingsScope: SettingsScopeBinder
  slots: SlotRegistry
}

export type SnapshotSelector<T, S> = (snapshot: T) => S

export interface SettingsCardProps<T> {
  t: Translate
  useCard: <S>(selector: SnapshotSelector<T, S>) => S
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}
