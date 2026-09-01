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
  ConnectionHandle,
  CredentialsApi,
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from './types.ts'

export const VISION_NS = 'vision'
/**
 * The credential slot used by new installations.  This is deliberately an
 * implementation detail: users edit the secret, not the slot name.
 */
export const DEFAULT_API_KEY_REF = 'DSH_VISION_API_KEY'
/** The slot used by older vision profiles before the built-in slot changed. */
export const LEGACY_API_KEY_REF = 'SELF_API_KEY'
const API_KEY_FIELD = 'apiKey'
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u
const UNKNOWN_CAPABILITY_POLICIES = ['passthrough', 'bridge'] as const
const DEFAULT_UNKNOWN_CAPABILITY_POLICY = 'passthrough'

export interface VisionSettings {
  enabled?: boolean
  protocol?: string
  baseURL?: string
  model?: string
  prompt?: string
  reasoningEffort?: string
  requestTimeoutMs?: number
  anthropicApiVersion?: string
  anthropicMaxTokens?: number
  describeMaxTokens?: number
  focusHint?: boolean
  unknownCapabilityPolicy?: 'passthrough' | 'bridge'
  cacheSize?: number
  maxEvidenceChars?: number
  maxImageBytes?: number
}

interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

interface CredentialSelection {
  /** Slot receiving a new key entered in the card. */
  writeRef: string
  /** Slots to inspect for the configured badge, in precedence order. */
  describeRefs: readonly string[]
}

export interface VisionCardState extends CardShell {
  enabled: CardFieldState
  protocol: CardFieldState
  baseURL: CardFieldState
  model: CardFieldState
  unknownCapabilityPolicy: CardFieldState
  prompt: CardFieldState
  reasoningEffort: CardFieldState
  requestTimeoutMs: CardFieldState
  describeMaxTokens: CardFieldState
  focusHint: CardFieldState
  cacheSize: CardFieldState
  maxEvidenceChars: CardFieldState
  maxImageBytes: CardFieldState
  apiKey: CardFieldState
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
}

export interface VisionCardFace extends CardActions {
  hooks: { visionCard: SnapshotStore<VisionCardState> }
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

function explicitRefOf(snapshot: SettingsScopeSnapshot<VisionSettings>): string | undefined {
  // `apiKeyEnv` is a legacy host setting. Read explicit values for existing
  // profiles, but never expose it as a staged field. The user layer is the
  // authoritative signal that a non-default slot was intentionally selected;
  // an explicit built-in default still uses the same new-to-legacy fallback
  // as the Host. A custom base/effective value is also honored.
  const user = layerRef(snapshot.user)
  if (user.present) return user.ref === DEFAULT_API_KEY_REF ? undefined : user.ref
  const base = layerRef(snapshot.base)
  if (base.ref !== undefined && base.ref !== DEFAULT_API_KEY_REF) return base.ref
  const value = layerRef(snapshot.value)
  if (value.ref !== undefined && value.ref !== DEFAULT_API_KEY_REF) return value.ref
  return undefined
}

function selectionOf(snapshot: SettingsScopeSnapshot<VisionSettings>): CredentialSelection {
  const explicit = explicitRefOf(snapshot)
  if (explicit !== undefined) return { writeRef: explicit, describeRefs: [explicit] }
  return {
    writeRef: DEFAULT_API_KEY_REF,
    describeRefs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF],
  }
}

function credentialsOf(connection: ConnectionHandle | undefined): CredentialsApi | undefined {
  return connection?.api
    && typeof connection.api.credentials === 'object'
    ? connection.api.credentials
    : undefined
}

/** Staged controller for the `vision` namespace and its write-only key. */
export class VisionCardController {
  private readonly form: CardForm<VisionSettings>
  private readonly store: SnapshotStore<VisionCardState>
  private readonly credentials: CredentialsApi | undefined
  private credential: CredentialState = { ref: DEFAULT_API_KEY_REF, configured: false, writable: false }
  private credentialReadGeneration = 0

  constructor(
    private readonly scope: SettingsScope<VisionSettings>,
    connection: ConnectionHandle | undefined,
  ) {
    this.credentials = credentialsOf(connection)
    this.form = new CardForm(
      scope,
      [
        booleanField('enabled'),
        enumField('protocol', ['openai-responses', 'openai-chat', 'anthropic']),
        textField('baseURL'),
        textField('model'),
        enumField('unknownCapabilityPolicy', UNKNOWN_CAPABILITY_POLICIES, DEFAULT_UNKNOWN_CAPABILITY_POLICY),
        textField('prompt'),
        textField('reasoningEffort'),
        numberField('requestTimeoutMs'),
        numberField('describeMaxTokens'),
        booleanField('focusHint'),
        numberField('cacheSize'),
        numberField('maxEvidenceChars'),
        numberField('maxImageBytes'),
      ],
      [{ field: API_KEY_FIELD, write: value => this.writeKey(value) }],
    )
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  inject(): VisionCardFace {
    return { hooks: { visionCard: this.store }, ...this.form.actions() }
  }

  refreshCredential(ref: string): void {
    const selection = selectionOf(this.scope.getSnapshot())
    if (!selection.describeRefs.includes(ref) && ref !== this.credential.ref) return
    void this.readCredential()
  }

  private projection(): VisionCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      protocol: this.form.field('protocol'),
      baseURL: this.form.field('baseURL'),
      model: this.form.field('model'),
      unknownCapabilityPolicy: this.form.field('unknownCapabilityPolicy'),
      prompt: this.form.field('prompt'),
      reasoningEffort: this.form.field('reasoningEffort'),
      requestTimeoutMs: this.form.field('requestTimeoutMs'),
      describeMaxTokens: this.form.field('describeMaxTokens'),
      focusHint: this.form.field('focusHint'),
      cacheSize: this.form.field('cacheSize'),
      maxEvidenceChars: this.form.field('maxEvidenceChars'),
      maxImageBytes: this.form.field('maxImageBytes'),
      apiKey: this.form.field(API_KEY_FIELD),
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
        writable: this.credentials?.set !== undefined,
      }
      this.store.set(this.projection())
    }
    const describe = this.credentials?.describe
    if (describe === undefined) return
    try {
      const response = await describe({ refs: [...selection.describeRefs] })
      const current = selectionOf(this.scope.getSnapshot())
      if (generation !== this.credentialReadGeneration
        || current.writeRef !== selection.writeRef
        || current.describeRefs.join('\u0000') !== selection.describeRefs.join('\u0000')) return
      if (!response.result.ok) return
      const views = selection.describeRefs.map(ref => response.result.value?.credentials?.[ref])
      const primary = views[0]
      const next: CredentialState = {
        ref: selection.writeRef,
        // The new slot wins by order. The legacy slot is only a migration
        // fallback so an existing key still appears configured until the user
        // enters a replacement, which is always written to the new slot.
        configured: views.some(view => view?.configured === true),
        writable: primary?.writable ?? (this.credentials?.set !== undefined),
      }
      if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
      this.credential = next
      this.store.set(this.projection())
    } catch {
      // A disconnected credentials plane does not prevent editing the other
      // settings; its next forwarded event or scope change retries the read.
    }
  }

  private async writeKey(value: string): Promise<boolean> {
    const ref = selectionOf(this.scope.getSnapshot()).writeRef
    const set = this.credentials?.set
    if (set === undefined) return false
    try {
      const response = await set({ ref, value })
      if (response.result.ok !== true) return false
    } catch {
      return false
    }
    await this.readCredential()
    return this.credential.ref === ref && this.credential.configured
  }
}
