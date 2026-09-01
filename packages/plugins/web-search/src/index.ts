/**
 * Host half of @dsh-desktop/web-search.
 *
 * The only Host contribution is a provider registration into `ctx.web`.  The
 * stable model-facing `web_search` tool belongs to dsh-tool-web, and the
 * selected chat model is deliberately never changed by this plugin.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
// Type-only: this contributes `ctx.web` and the provider contract without
// pulling Host implementation source into this package.
import type { WebSearchProvider as DshWebSearchProvider } from '@deepseek-ai/dsh-web'
import {
  DEFAULT_PROMPT,
  WebSearchProvider,
  isCredentialRefName,
  isHttpUrl,
  type SearchProtocol,
  type WebSearchProviderOptions,
} from './provider.ts'

/** Loader-visible plugin identity. */
export const name = 'web-search'

/** The web capability service this provider registers into. */
export const inject = ['web']

/** Stable provider id selected by this package's bundle patch. */
export const PROVIDER_ID = 'dsh-web-search'

/** Settings namespace paired with the browser card. */
export const WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace('web-search')

/**
 * Internal credential reference used by new installations.  The API key value
 * is owned by the credentials service and never belongs in this settings
 * namespace.
 */
export const DEFAULT_API_KEY_ENV = 'DSH_WEB_SEARCH_API_KEY'

/** Reference used by the first desktop web-search bundle. */
export const LEGACY_DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Environment fallback for an auxiliary-search endpoint. */
export const SEARCH_BASE_URL_ENV = 'DSH_WEB_SEARCH_BASE_URL'

/** Built-in protocol and model defaults. */
export const DEFAULT_PROTOCOL: SearchProtocol = 'openai-responses'
export const DEFAULT_MODEL = 'deepseek-v4-flash'
export const DEFAULT_REASONING_EFFORT = 'low'
export const DEFAULT_TIMEOUT_MS = 55_000
export const DEFAULT_ANTHROPIC_API_VERSION = '2023-06-01'
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4_096
export const DEFAULT_ANTHROPIC_MAX_USES = 5

/** Config accepted by the Host settings namespace. */
export interface Config {
  /** Whether this provider may be selected. */
  enabled?: boolean
  /** Wire protocol used for the auxiliary search request. */
  protocol?: SearchProtocol
  /** Endpoint base; `/responses` or `/messages` is appended. */
  baseURL?: string
  /** Hidden legacy reference, never the secret itself. */
  apiKeyEnv?: string
  /** Auxiliary model name. */
  model?: string
  /** OpenAI Responses reasoning effort; empty means omit reasoning. */
  reasoningEffort?: string
  /** Hard per-request timeout, bounded below the web tool budget. */
  requestTimeoutMs?: number
  /** Anthropic Messages `anthropic-version` header. */
  anthropicApiVersion?: string
  /** Anthropic Messages `max_tokens`. */
  anthropicMaxTokens?: number
  /** Anthropic server search tool `max_uses`. */
  anthropicMaxUses?: number
}

/**
 * The schema is also the source of settings-card metadata.  The product prompt
 * intentionally is not represented here: callers cannot accidentally replace
 * the instruction that makes the auxiliary model perform native search.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  protocol: z.union(['openai-responses', 'anthropic']).default(DEFAULT_PROTOCOL),
  // Empty means "use DSH_WEB_SEARCH_BASE_URL".  Schemastery does not expose
  // an `.optional()` builder, so an empty default keeps the section present in
  // settings while preserving the environment fallback in resolveOptions.
  baseURL: z.string().default(''),
  /** Keep old explicit references readable without exposing the slot to users. */
  apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).role('credential-ref').hidden().default(DEFAULT_API_KEY_ENV),
  model: z.string().min(1).default(DEFAULT_MODEL),
  reasoningEffort: z.string().default(DEFAULT_REASONING_EFFORT),
  requestTimeoutMs: z.number().step(1).min(1).max(60_000).default(DEFAULT_TIMEOUT_MS),
  anthropicApiVersion: z.string().min(1).default(DEFAULT_ANTHROPIC_API_VERSION),
  anthropicMaxTokens: z.number().step(1).min(1).default(DEFAULT_ANTHROPIC_MAX_TOKENS),
  anthropicMaxUses: z.number().step(1).min(1).default(DEFAULT_ANTHROPIC_MAX_USES),
})

/**
 * Validate cross-field and transport constraints that a schema cannot express.
 * Invalid settings are rejected at commit time, not deferred until a model
 * happens to ask for a search.
 */
export function validateConfig(config: Config): void {
  if (config.apiKeyEnv !== undefined && !isCredentialRefName(config.apiKeyEnv)) {
    throw new TypeError(`web-search apiKeyEnv must be a POSIX environment name, got "${config.apiKeyEnv}"`)
  }
  if (config.baseURL !== undefined && config.baseURL.trim().length > 0 && !isHttpUrl(config.baseURL.trim())) {
    throw new TypeError('web-search baseURL must be an absolute http(s) URL without embedded credentials')
  }
  if (config.model !== undefined && config.model.trim().length === 0) {
    throw new TypeError('web-search model must be a non-empty string')
  }
  if (config.reasoningEffort !== undefined && config.reasoningEffort.trim().length > 64) {
    throw new TypeError('web-search reasoningEffort is too long')
  }
  if (config.anthropicApiVersion !== undefined && config.anthropicApiVersion.trim().length === 0) {
    throw new TypeError('web-search anthropicApiVersion must be non-empty')
  }
  for (const [key, value] of [
    ['requestTimeoutMs', config.requestTimeoutMs],
    ['anthropicMaxTokens', config.anthropicMaxTokens],
    ['anthropicMaxUses', config.anthropicMaxUses],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`web-search ${key} must be a positive integer`)
    }
  }
  if (config.requestTimeoutMs !== undefined && config.requestTimeoutMs > 60_000) {
    throw new TypeError('web-search requestTimeoutMs must be no greater than 60000')
  }
}

interface CredentialResolver {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

interface LaunchValue {
  readonly value: string
}

function ambientValue(ctx: Context, key: string): string | undefined {
  try {
    const value = launchEnvironmentOf(ctx).get(key) as LaunchValue | undefined
    if (value !== undefined && value.value.length > 0) return value.value
  } catch {
    // A minimal composition may not mount launch-environment.  Do not bypass
    // the launch snapshot with a direct process.env read: the snapshot is the
    // sole ambient source and preserves the launcher's isolation/precedence.
  }
  return undefined
}

/**
 * Keep the old built-in slot readable after the default changes.  A custom
 * (including explicitly selected `SELF_API_KEY`) reference is authoritative;
 * only the new built-in slot gets the one-way compatibility fallback.
 */
function credentialRefs(primary: string): readonly string[] {
  return primary === DEFAULT_API_KEY_ENV
    ? [primary, LEGACY_DEFAULT_API_KEY_ENV]
    : [primary]
}

/**
 * Project one settings snapshot into operation options.  The provider receives
 * this thunk and resolves it once per search, so a live settings update cannot
 * mix the old endpoint with a new model or credential reference mid-call.
 */
export function resolveOptions(ctx: Context, config: Config): WebSearchProviderOptions {
  const apiKeyEnvName = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const apiKeyEnv = isCredentialRefName(apiKeyEnvName) ? credentialRef(apiKeyEnvName) : undefined
  const apiKeyRefs = apiKeyEnv === undefined
    ? []
    : credentialRefs(apiKeyEnv).map(ref => credentialRef(ref))
  const configuredBaseURL = config.baseURL?.trim()
  const baseURL = (configuredBaseURL !== undefined && configuredBaseURL.length > 0
    ? configuredBaseURL
    : ambientValue(ctx, SEARCH_BASE_URL_ENV) ?? '').replace(/\/+$/u, '')
  return {
    enabled: config.enabled !== false,
    protocol: config.protocol ?? DEFAULT_PROTOCOL,
    baseURL,
    model: (config.model ?? DEFAULT_MODEL).trim(),
    effort: (config.reasoningEffort ?? DEFAULT_REASONING_EFFORT).trim(),
    timeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    apiVersion: (config.anthropicApiVersion ?? DEFAULT_ANTHROPIC_API_VERSION).trim(),
    maxTokens: config.anthropicMaxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    maxUses: config.anthropicMaxUses ?? DEFAULT_ANTHROPIC_MAX_USES,
    apiKeyEnv,
    prompt: DEFAULT_PROMPT,
    resolveApiKey: async () => {
      if (apiKeyEnv === undefined) return undefined
      let credentials: CredentialResolver | undefined
      try {
        credentials = ctx.get('credentials') as CredentialResolver | undefined
      } catch {
        credentials = undefined
      }
      if (credentials !== undefined) {
        // The mounted credentials provider owns the complete resolution
        // precedence chain. Never fall through to ambient values when it is
        // present, even when a reference is currently unset.
        for (const ref of apiKeyRefs) {
          const resolved = await credentials.resolve(ref)
          if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
        }
        return undefined
      }
      for (const ref of apiKeyRefs) {
        const value = ambientValue(ctx, ref)
        if (value !== undefined) return value
      }
      return undefined
    },
  }
}

/** Register the provider and its optional settings namespace. */
export function apply(ctx: Context, config: Config = {}): void {
  validateConfig(config)
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_SETTINGS_NAMESPACE, Config, config, {
    validate: validateConfig,
    setSource: source => { current = source },
    // The provider reads the source at operation entry; no re-registration is
    // needed when settings hot-reload or the settings service detaches.
    onChange: () => {},
  })
  const provider: DshWebSearchProvider = new WebSearchProvider(() => resolveOptions(ctx, current()))
  ctx.web.registerSearchProvider(provider)
}

export { DEFAULT_PROMPT, WebSearchProvider } from './provider.ts'
export {
  MAX_CONTENT_CHARS,
  MAX_QUERY_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_SOURCE_FIELD_CHARS,
  MAX_SOURCE_URL_CHARS,
  buildSearchPrompt,
  isHttpUrl,
  isCredentialRefName,
  mapAnthropicResponse,
  mapResponsesResponse,
} from './provider.ts'
export type { SearchProtocol, WebSearchProviderOptions } from './provider.ts'
