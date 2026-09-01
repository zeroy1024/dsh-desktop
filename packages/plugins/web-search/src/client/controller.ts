/** Settings card controller for the host-plane `web-search` namespace. */

import {
  CardForm,
  booleanField,
  enumField,
  numberField,
  textField,
  type CardActions,
  type CardFieldState,
  type CardShell,
} from './card-form.ts'
import type {
  ApiClient,
  CredentialView,
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from './types.ts'

/** Stable settings namespace; kept as a literal so the browser half is standalone. */
export const WEB_SEARCH_NS = 'web-search'

/**
 * The credential slot used by new installations. This is deliberately an
 * implementation detail: users edit the secret, not the slot name.
 */
export const DEFAULT_API_KEY_REF = 'DSH_WEB_SEARCH_API_KEY'
/** The slot used by older web-search profiles before the built-in slot changed. */
export const LEGACY_API_KEY_REF = 'DEEPSEEK_API_KEY'

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u
const PROTOCOLS = ['openai-responses', 'anthropic'] as const

export interface WebSearchSettings {
  enabled?: boolean
  protocol?: 'openai-responses' | 'anthropic'
  baseURL?: string
  model?: string
  reasoningEffort?: string
  requestTimeoutMs?: number
  anthropicApiVersion?: string
  anthropicMaxTokens?: number
  anthropicMaxUses?: number
}

interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

export interface WebSearchCardState extends CardShell {
  enabled: CardFieldState
  protocol: CardFieldState
  baseURL: CardFieldState
  model: CardFieldState
  reasoningEffort: CardFieldState
  requestTimeoutMs: CardFieldState
  anthropicApiVersion: CardFieldState
  anthropicMaxTokens: CardFieldState
  anthropicMaxUses: CardFieldState
  apiKey: CardFieldState
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
}

export interface WebSearchCardFace extends CardActions {
  hooks: {
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

interface CredentialSelection {
  /** Slot receiving a new key entered in the card. */
  writeRef: string
  /** Slots to inspect for the configured badge, in precedence order. */
  describeRefs: readonly string[]
}

function layerRef(value: unknown): { present: boolean; ref?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { present: false }
  }
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'apiKeyEnv')) return { present: false }
  const candidate = record['apiKeyEnv']
  return {
    present: true,
    ref: typeof candidate === 'string' && CREDENTIAL_REF.test(candidate) ? candidate : undefined,
  }
}

function explicitRefOf(snapshot: SettingsScopeSnapshot<WebSearchSettings>): string | undefined {
  // `apiKeyEnv` is a legacy host setting. Read explicit values for existing
  // profiles, but never expose it as a staged field. The user layer is the
  // authoritative signal that a slot was intentionally selected; a custom
  // base/effective value is also honored when it is not the new default.
  const user = layerRef(snapshot.user)
  if (user.present) return user.ref === DEFAULT_API_KEY_REF ? undefined : user.ref
  const base = layerRef(snapshot.base)
  if (base.ref !== undefined && base.ref !== DEFAULT_API_KEY_REF) return base.ref
  const value = layerRef(snapshot.value)
  if (value.ref !== undefined && value.ref !== DEFAULT_API_KEY_REF) return value.ref
  return undefined
}

function selectionOf(snapshot: SettingsScopeSnapshot<WebSearchSettings>): CredentialSelection {
  const explicit = explicitRefOf(snapshot)
  if (explicit !== undefined) return { writeRef: explicit, describeRefs: [explicit] }
  return {
    writeRef: DEFAULT_API_KEY_REF,
    describeRefs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF],
  }
}

function resultView(response: unknown, ref: string): CredentialView | undefined {
  if (typeof response !== 'object' || response === null) return undefined
  const result = (response as { result?: unknown }).result
  if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== true) return undefined
  const value = (result as { value?: unknown }).value
  if (typeof value !== 'object' || value === null) return undefined
  const credentials = (value as { credentials?: unknown }).credentials
  if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials)) return undefined
  const view = (credentials as Record<string, unknown>)[ref]
  if (typeof view !== 'object' || view === null) return undefined
  const candidate = view as Record<string, unknown>
  if (typeof candidate.configured !== 'boolean' || typeof candidate.writable !== 'boolean') return undefined
  return {
    configured: candidate.configured,
    writable: candidate.writable,
    ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
  }
}

/** Owns staged settings and the separate credentials-domain interaction. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private credential: CredentialState = {
    ref: DEFAULT_API_KEY_REF,
    configured: false,
    writable: false,
  }
  private credentialReadGeneration = 0

  constructor(
    private readonly scope: SettingsScope<WebSearchSettings>,
    private readonly api: ApiClient,
  ) {
    this.form = new CardForm(
      scope,
      [
        booleanField('enabled', true),
        enumField('protocol', PROTOCOLS, 'openai-responses'),
        textField('baseURL'),
        textField('model', 'deepseek-v4-flash'),
        textField('reasoningEffort', 'low'),
        numberField('requestTimeoutMs'),
        textField('anthropicApiVersion', '2023-06-01'),
        numberField('anthropicMaxTokens'),
        numberField('anthropicMaxUses'),
      ],
      [{ field: 'apiKey', write: value => this.writeKey(value) }],
    )
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  inject(): WebSearchCardFace {
    return { hooks: { webSearchCard: this.store }, ...this.form.actions() }
  }

  refreshCredential(ref: string): void {
    const selection = selectionOf(this.scope.getSnapshot())
    if (!selection.describeRefs.includes(ref) && ref !== this.credential.ref) return
    void this.readCredential()
  }

  private projection(): WebSearchCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      protocol: this.form.field('protocol'),
      baseURL: this.form.field('baseURL'),
      model: this.form.field('model'),
      reasoningEffort: this.form.field('reasoningEffort'),
      requestTimeoutMs: this.form.field('requestTimeoutMs'),
      anthropicApiVersion: this.form.field('anthropicApiVersion'),
      anthropicMaxTokens: this.form.field('anthropicMaxTokens'),
      anthropicMaxUses: this.form.field('anthropicMaxUses'),
      apiKey: this.form.field('apiKey'),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  private async readCredential(): Promise<void> {
    const selection = selectionOf(this.scope.getSnapshot())
    const generation = ++this.credentialReadGeneration
    if (selection.writeRef !== this.credential.ref) {
      this.credential = {
        ref: selection.writeRef,
        configured: false,
        writable: this.api.credentials?.set !== undefined,
      }
      this.store.set(this.projection())
    }
    let response: unknown
    try {
      const describe = this.api.credentials?.describe
      if (describe === undefined) return
      response = await describe({ refs: [...selection.describeRefs] })
    } catch {
      return
    }
    if (generation !== this.credentialReadGeneration) return
    const current = selectionOf(this.scope.getSnapshot())
    if (current.writeRef !== selection.writeRef
      || current.describeRefs.join('\u0000') !== selection.describeRefs.join('\u0000')) return
    const views = selection.describeRefs.map(ref => resultView(response, ref))
    if (views.every(view => view === undefined)) return
    const primary = views[0]
    this.credential = {
      ref: selection.writeRef,
      // The new slot wins by order. The legacy slot is only a migration
      // fallback so an existing key still appears configured until the user
      // enters a replacement, which is always written to the new slot.
      configured: views.some(view => view?.configured === true),
      writable: primary?.writable ?? (this.api.credentials?.set !== undefined),
    }
    this.store.set(this.projection())
  }

  private async writeKey(value: string): Promise<boolean> {
    const targetRef = selectionOf(this.scope.getSnapshot()).writeRef
    const set = this.api.credentials?.set
    if (set === undefined) return false
    try {
      const response = await set({ ref: targetRef, value })
      const result = response.result
      if (result.ok !== true) return false
    } catch {
      return false
    }
    await this.readCredential()
    return this.credential.ref === targetRef && this.credential.configured
  }
}
