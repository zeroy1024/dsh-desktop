/**
 * Local structural mirrors for the public client seams used by this plugin.
 * The desktop boundary forbids importing upstream source; these declarations
 * are intentionally limited to the fields the card touches.
 */

export interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

export interface SettingsScope<T> {
  getSnapshot: () => SettingsScopeSnapshot<T>
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => Promise<void>
  unset: (field: string) => Promise<void>
}

export interface SettingsScopeBinder {
  bind: <T>(spec: { namespace: string }) => SettingsScope<T>
}

export interface SnapshotStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  set: (next: T) => void
}

export type SnapshotSelectorHook<T> = <S>(
  selector: (snapshot: T) => S,
  equal?: (previous: S, next: S) => boolean,
) => S

export interface CredentialView {
  configured: boolean
  writable: boolean
}

export interface CredentialsApi {
  describe?: (request: { refs: string[] }) => Promise<{
    result: { ok: boolean; value?: { credentials: Record<string, CredentialView | undefined> } }
  }>
  set?: (request: { ref: string; value: string }) => Promise<{
    result: { ok: boolean; value?: Record<string, never> }
  }>
}

export interface ConnectionHandle {
  api: { credentials?: CredentialsApi }
}

export interface RemoteHandle {
  $on?: (event: string, listener: (value: string) => void) => () => void
}

export interface LocaleHandle {
  register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => unknown
  bind: (namespace: string) => Translate
}

export type Translate = (key: string, params?: Record<string, string | number>) => string

export interface SlotRegistrationOptions {
  name: string
  key?: string
  id?: string
  locale?: string
  order?: number
  inject?: () => unknown
}

export interface SlotHandle {
  inject: (name: string, factory: () => unknown) => unknown
  register: (options: SlotRegistrationOptions, component: unknown) => unknown
}

export interface ClientContext {
  get: (key: string) => unknown
  effect: (factory: () => void | (() => void | Promise<void>), name?: string) => unknown
  settingsScope: SettingsScopeBinder
  slots: SlotHandle
  locale: LocaleHandle
  remote?: RemoteHandle
}

export interface VisionCardProps {
  t: Translate
  useVisionCard: SnapshotSelectorHook<import('./vision-card-controller.ts').VisionCardState>
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}
