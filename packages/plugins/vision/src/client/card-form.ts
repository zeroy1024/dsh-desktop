/** Small staged settings form shared by the vision card and its tests. */

import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from './types.ts'

export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

export interface CardFieldSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => FieldWrite | undefined
}

export interface CardSecretSpec {
  field: string
  write: (text: string) => Promise<boolean>
}

export interface CardFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

export interface CardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

interface StagedEdit {
  text: string
  clear: boolean
}

interface PlannedWrite {
  run: (() => Promise<boolean>) | undefined
}

function snapshotValue<T>(snapshot: SettingsScopeSnapshot<T>, field: string): unknown {
  const value = snapshot.value
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined
}

function snapshotBase<T>(snapshot: SettingsScopeSnapshot<T>, field: string): unknown {
  const value = snapshot.base
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined
}

function snapshotUser<T>(snapshot: SettingsScopeSnapshot<T>): Record<string, unknown> | undefined {
  return typeof snapshot.user === 'object' && snapshot.user !== null && !Array.isArray(snapshot.user)
    ? snapshot.user as Record<string, unknown>
    : undefined
}

export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: text => text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() },
  }
}

export function numberField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: text => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const value = Number(trimmed)
      return Number.isSafeInteger(value) ? { kind: 'set', value } : undefined
    },
  }
}

export function booleanField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: text => {
      const normalized = text.trim().toLowerCase()
      if (normalized === '') return { kind: 'clear' }
      if (normalized === 'true') return { kind: 'set', value: true }
      if (normalized === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

export function enumField(field: string, values: readonly string[], fallback = ''): CardFieldSpec {
  const allowed = new Set(values)
  return {
    field,
    format: value => typeof value === 'string' && allowed.has(value) ? value : fallback,
    parse: text => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.has(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

export function listField(field: string): CardFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.filter(item => typeof item === 'string').join(', ') : '',
    parse: text => {
      const values = [...new Set(text.split(',').map(item => item.trim()).filter(Boolean))]
      return values.length === 0 ? { kind: 'clear' } : { kind: 'set', value: values }
    },
  }
}

/**
 * Settings writes are deliberately deferred to save().  Scope writes carry
 * their latest revision, and the read-back below keeps drafts on a conflict
 * instead of making a concurrent change look like a successful save.
 */
export class CardForm<T> {
  private readonly specs = new Map<string, CardFieldSpec>()
  private readonly secrets = new Map<string, CardSecretSpec>()
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false
  private readonly store: SnapshotStore<CardShell>

  constructor(
    private readonly scope: SettingsScope<T>,
    specs: readonly CardFieldSpec[],
    secrets: readonly CardSecretSpec[] = [],
  ) {
    for (const spec of specs) this.specs.set(spec.field, spec)
    for (const secret of secrets) this.secrets.set(secret.field, secret)
    this.store = createStore(this.shell())
    scope.subscribe(() => {
      this.publish()
    })
  }

  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(field: string): CardFieldState {
    const staged = this.staged.get(field)
    if (this.secrets.has(field)) {
      return { text: staged?.text ?? '', overridden: false, invalid: false }
    }
    const spec = this.spec(field)
    if (staged === undefined) {
      return {
        text: spec.format(snapshotValue(this.scope.getSnapshot(), field)),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  actions(): CardActions {
    return {
      edit: (field, text) => {
        if (!this.secrets.has(field)) this.spec(field)
        this.staged.set(field, { text, clear: false })
        this.failed = false
        this.publish()
      },
      resetField: field => {
        this.spec(field)
        const value = this.spec(field).format(snapshotBase(this.scope.getSnapshot(), field))
        this.staged.set(field, { text: value, clear: true })
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || plan.some(item => item.run === undefined)) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const item of plan) {
      try {
        landed = await item.run!() && landed
      } catch {
        landed = false
      }
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const secret = this.secrets.get(field)
      if (secret !== undefined) {
        const value = staged.text.trim()
        if (value !== '') plan.push({ run: () => secret.write(value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(snapshotValue(this.scope.getSnapshot(), field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ run: undefined })
      else if (write.kind === 'clear') plan.push({ run: () => this.clear(field) })
      else plan.push({ run: () => this.storeValue(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async storeValue(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    const user = snapshotUser(this.scope.getSnapshot())
    // The Host detaches JSON values before publishing them, so compare the
    // detached value structurally rather than relying on object identity.
    return user !== undefined && jsonEqual(user[field], value)
  }

  private stored(field: string): boolean {
    const user = snapshotUser(this.scope.getSnapshot())
    return user !== undefined && Object.hasOwn(user, field)
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`vision settings card has no field ${field}`)
    return spec
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
    this.store.set(this.shell())
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function createStore<T>(initial: T): SnapshotStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}
