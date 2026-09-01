/**
 * Small, plugin-owned staged settings form.
 *
 * The upstream Plugins section intentionally does not export its card model as
 * a reusable value.  This copy keeps the same important semantics locally:
 * drafts are written only on Save, Reset stages an `unset`, and every write is
 * delegated to the official SettingsScope (which fences it with its revision).
 */

import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from './types.ts'

export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

export interface CardFieldSpec {
  field: string
  format(value: unknown): string
  parse(text: string): FieldWrite | undefined
}

export interface CardSecretSpec {
  field: string
  write(text: string): Promise<boolean>
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
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

interface StagedEdit {
  text: string
  clear: boolean
}

interface PlannedWrite {
  field: string
  run: (() => Promise<boolean>) | undefined
  secret: boolean
}

/** Minimal observable store used by slot hooks; no upstream runtime import. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    set: (next) => {
      if (Object.is(snapshot, next)) return
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function textField(field: string, fallback = ''): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : fallback,
    parse: (text) => {
      const value = text.trim()
      return value.length === 0 ? { kind: 'clear' } : { kind: 'set', value }
    },
  }
}

export function numberField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const value = text.trim()
      if (value.length === 0) return { kind: 'clear' }
      const parsed = Number(value)
      return Number.isSafeInteger(parsed) && parsed > 0
        ? { kind: 'set', value: parsed }
        : undefined
    },
  }
}

export function booleanField(field: string, fallback = false): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : String(fallback),
    parse: (text) => {
      const value = text.trim().toLowerCase()
      if (value === 'true') return { kind: 'set', value: true }
      if (value === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

export function enumField(field: string, values: readonly string[], fallback?: string): CardFieldSpec {
  const allowed = new Set(values)
  return {
    field,
    format: value => typeof value === 'string' && allowed.has(value) ? value : fallback ?? '',
    parse: (text) => {
      const value = text.trim()
      if (value.length === 0) return { kind: 'clear' }
      return allowed.has(value) ? { kind: 'set', value } : undefined
    },
  }
}

export function predicateTextField(
  field: string,
  valid: (value: string) => boolean,
  fallback = '',
): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : fallback,
    parse: (text) => {
      const value = text.trim()
      if (value.length === 0) return { kind: 'clear' }
      return valid(value) ? { kind: 'set', value } : undefined
    },
  }
}

export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>
  private readonly secrets: Map<string, CardSecretSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(
    private readonly scope: SettingsScope<T>,
    specs: readonly CardFieldSpec[],
    secrets: readonly CardSecretSpec[] = [],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    this.secrets = new Map(secrets.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
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
        text: spec.format(this.sectionValue(field)),
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
        this.assertKnown(field)
        this.staged.set(field, { text, clear: false })
        this.failed = false
        this.publish()
      },
      resetField: (field) => {
        const spec = this.spec(field)
        this.staged.set(field, { text: spec.format(this.baseValue(field)), clear: true })
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
    if (this.saving) return
    const plan = this.plan()
    if (plan.length === 0 || plan.some(item => item.run === undefined)) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      // Normal settings writes intentionally precede secrets. Secret slots are
      // resolved by the controller at save time, so no key is written to a
      // stale settings-derived target.
      for (const item of plan) {
        if (item.run === undefined) continue
        try {
          landed = await item.run() && landed
        } catch {
          landed = false
        }
      }
    } finally {
      this.saving = false
      this.failed = !landed
      if (landed) this.staged.clear()
      this.publish()
    }
  }

  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    const normal: PlannedWrite[] = []
    const secret: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const secretSpec = this.secrets.get(field)
      if (secretSpec !== undefined) {
        const value = staged.text.trim()
        if (value.length > 0) secret.push({ field, run: () => secretSpec.write(value), secret: true })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) normal.push({ field, run: () => this.clear(field), secret: false })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) normal.push({ field, run: undefined, secret: false })
      else if (write.kind === 'clear') normal.push({ field, run: () => this.clear(field), secret: false })
      else normal.push({ field, run: () => this.store(field, write.value), secret: false })
    }
    for (const item of normal) plan.push(item)
    for (const item of secret) plan.push(item)
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.stored(field) && Object.is(this.userLayer()?.[field], value)
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`web-search settings card has no field ${field}`)
    return spec
  }

  private assertKnown(field: string): void {
    if (!this.specs.has(field) && !this.secrets.has(field)) {
      throw new Error(`web-search settings card has no field ${field}`)
    }
  }

  private snapshot(): SettingsScopeSnapshot<T> {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    return (this.snapshot().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.snapshot().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshot().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
