/**
 * Provider-neutral image bridge primitives.
 *
 * This module deliberately has no dsh imports.  The Host half supplies the
 * runtime seams (settings, attachments and LLM), while tests can exercise the
 * safety and cache rules without installing a dsh profile.  The public
 * dsh-facing adapter lives in `index.ts` and only uses these structural types.
 */

import { createHash } from 'node:crypto'

export const VISION_PLUGIN_NAME = '@dsh-desktop/vision'
export const LEGACY_VISION_PLUGIN_NAME = 'dsh-vision'

export const DEFAULT_PROTOCOL = 'openai-responses' as const
/**
 * Internal credential reference used by new installations.  This is a
 * reference name only; the API key itself belongs to the credentials service
 * and must never be copied into the vision settings namespace.
 */
export const DEFAULT_API_KEY_ENV = 'DSH_VISION_API_KEY'
/** Reference used by releases that predated the built-in vision slot. */
export const LEGACY_DEFAULT_API_KEY_ENV = 'SELF_API_KEY'
export const DEFAULT_MODEL = 'grok-4.6'
export const DEFAULT_REASONING_EFFORT = 'low'
export const DEFAULT_TIMEOUT_MS = 90_000
export const DEFAULT_ANTHROPIC_API_VERSION = '2023-06-01'
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096
export const DEFAULT_DESCRIBE_MAX_TOKENS = 1024
export const DEFAULT_CACHE_SIZE = 64
export const DEFAULT_MAX_EVIDENCE_CHARS = 12_000
export const DEFAULT_UNKNOWN_CAPABILITY_POLICY = 'passthrough' as const

/** Hard resource bounds. Settings may lower these, never raise them. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
export const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024
export const MAX_PROMPT_CHARS = 16_000
export const MAX_FOCUS_CHARS = 2_000
export const MAX_EVIDENCE_CHARS = 50_000

export const MEDIA_TYPES = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true,
  'image/heic': true,
  'image/heif': true,
} as const

export type VisionProtocol = 'openai-responses' | 'openai-chat' | 'anthropic'
export type UnknownCapabilityPolicy = 'passthrough' | 'bridge'

/** Configuration stored in the `vision` settings namespace. */
export interface VisionConfig {
  enabled?: boolean
  protocol?: VisionProtocol
  baseURL?: string
  /** Hidden legacy reference; new callers use the built-in slot. */
  apiKeyEnv?: string
  model?: string
  prompt?: string
  reasoningEffort?: string
  requestTimeoutMs?: number
  anthropicApiVersion?: string
  anthropicMaxTokens?: number
  describeMaxTokens?: number
  focusHint?: boolean
  unknownCapabilityPolicy?: UnknownCapabilityPolicy
  /** Deprecated legacy fields are accepted for settings migration only. */
  upstream?: string
  families?: string[]
  models?: string[]
  cacheSize?: number
  maxEvidenceChars?: number
  maxImageBytes?: number
}

/** Fully projected configuration used by one image operation. */
export interface VisionOptions {
  enabled: boolean
  protocol: VisionProtocol
  baseURL: string
  apiKeyEnv: string
  model: string
  prompt: string
  effort: string
  timeoutMs: number
  apiVersion: string
  maxTokens: number
  describeMaxTokens: number
  focusHint: boolean
  unknownCapabilityPolicy: UnknownCapabilityPolicy
  cacheSize: number
  maxEvidenceChars: number
  maxImageBytes: number
  /** An API-key resolver is injected by the Host context. */
  resolveApiKey?: () => Promise<string | undefined>
}

export interface VisionModelInfo {
  inputModalities?: readonly string[]
  [key: string]: unknown
}

/** Native image support as reported by the model's provider adapter. */
export type ImageCapability = 'native' | 'unsupported' | 'unknown'

export type ResolveModelInfo = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<VisionModelInfo | undefined>

export interface ImageBlock {
  type: 'image'
  attachment: unknown
}

export interface ToolResultBlock {
  type: 'tool-result'
  content: readonly ContentBlock[]
  [key: string]: unknown
}

export interface TextBlock {
  type: 'text'
  text: string
  [key: string]: unknown
}

export type ContentBlock = ImageBlock | ToolResultBlock | TextBlock | Record<string, unknown>

export interface Message {
  role?: string
  content?: readonly ContentBlock[]
  source?: unknown
  [key: string]: unknown
}

export interface EvidenceResult {
  ok: boolean
  text: string
  error?: unknown
}

export interface EvidenceCache {
  get(key: string): Promise<EvidenceResult> | undefined
  peek(key: string): Promise<EvidenceResult> | undefined
  set(key: string, value: Promise<EvidenceResult>): void
  deleteKey(key: string): void
  clear(): void
  size(): number
}

/** A fixed-size LRU cache. Rejected operations are removed by the caller. */
export function makeEvidenceCache(getSize: () => number): EvidenceCache {
  const values = new Map<string, Promise<EvidenceResult>>()
  const limit = (): number => {
    const value = getSize()
    return Number.isSafeInteger(value) && value > 0 ? Math.min(256, value) : DEFAULT_CACHE_SIZE
  }
  const trim = (): void => {
    while (values.size > limit()) {
      const oldest = values.keys().next().value
      if (oldest === undefined) break
      values.delete(oldest)
    }
  }
  const touch = (key: string): Promise<EvidenceResult> | undefined => {
    const value = values.get(key)
    if (value !== undefined) {
      values.delete(key)
      values.set(key, value)
    }
    return value
  }
  return {
    get: touch,
    peek: key => values.get(key),
    set: (key, value) => {
      values.delete(key)
      values.set(key, value)
      trim()
    },
    deleteKey: key => { values.delete(key) },
    clear: () => { values.clear() },
    size: () => values.size,
  }
}

/** Stable, short digest suitable for cache keys and durable section names. */
export function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function jsonForKey(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === 'bigint') return `${String(entry)}n`
      if (entry instanceof Uint8Array) return { byteLength: entry.byteLength }
      return entry
    })
  } catch {
    return String(value)
  }
}

/** Configuration identity excludes the credential literal by design. */
export function configFingerprint(opts: VisionOptions): string {
  return stableDigest(jsonForKey({
    protocol: opts.protocol,
    baseURL: opts.baseURL,
    model: opts.model,
    prompt: opts.prompt,
    effort: opts.effort,
    timeoutMs: opts.timeoutMs,
    apiVersion: opts.apiVersion,
    maxTokens: opts.maxTokens,
    describeMaxTokens: opts.describeMaxTokens,
    focusHint: opts.focusHint,
    maxEvidenceChars: opts.maxEvidenceChars,
    maxImageBytes: opts.maxImageBytes,
  }))
}

/** Return a content-addressed identity for the attachment plus operation focus. */
export function evidenceKey(
  block: ImageBlock,
  opts: VisionOptions,
  focus: string,
): string {
  const attachment = block.attachment as Record<string, unknown> | null | undefined
  const attachmentIdentity = {
    id: attachment?.attachmentId ?? attachment?.id ?? attachment,
    mediaType: attachment?.mediaType,
    bytes: attachment?.bytes,
  }
  return `dsh-vision:v1:${stableDigest(jsonForKey(attachmentIdentity))}:${configFingerprint(opts)}:${stableDigest(focus)}`
}

/** Recursively detect images, including nested tool-result content. */
export function contentHasImage(content: readonly unknown[]): boolean {
  return content.some((block) => {
    if (typeof block !== 'object' || block === null) return false
    const candidate = block as Record<string, unknown>
    if (candidate.type === 'image') return true
    return candidate.type === 'tool-result'
      && Array.isArray(candidate.content)
      && contentHasImage(candidate.content)
  })
}

export function messagesContainImage(messages: readonly Message[]): boolean {
  return messages.some(message => Array.isArray(message.content) && contentHasImage(message.content))
}

/** Extract the latest user text used as a bounded focus hint. */
export function extractFocus(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block): block is TextBlock => (
        typeof block === 'object' && block !== null
        && (block as Record<string, unknown>).type === 'text'
        && typeof (block as Record<string, unknown>).text === 'string'
      ))
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text.slice(-MAX_FOCUS_CHARS)
  }
  return ''
}

/** Return true only when the provider explicitly declares image input. */
export function declaresImage(info: VisionModelInfo | undefined): boolean {
  return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
}

export function imageCapability(info: VisionModelInfo | undefined): ImageCapability {
  if (!Array.isArray(info?.inputModalities)) return 'unknown'
  return declaresImage(info) ? 'native' : 'unsupported'
}

interface ImageCapabilityInspection {
  capability: ImageCapability
  failed?: boolean
  error?: unknown
}

async function inspectImageCapability(
  resolveInfo: ResolveModelInfo | undefined,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<ImageCapabilityInspection> {
  if (signal?.aborted === true) throw visionAborted(signal)
  try {
    const pending = resolveInfo === undefined
      ? Promise.resolve(undefined)
      : resolveInfo(provider, model, signal)
    const info = await abortableWait(pending, signal)
    return { capability: imageCapability(info) }
  } catch (error) {
    if (signal?.aborted) throw visionAborted(signal)
    // An adapter can surface cancellation before its caller-visible signal is
    // observed as aborted. Never turn cancellation into an auxiliary upload,
    // even when the user opted into bridging unknown capabilities.
    if (isAbortError(error) || (error instanceof VisionError && error.code === 'VISION_ABORTED')) {
      throw visionAborted(signal, error)
    }
    return { capability: 'unknown', failed: true, error }
  }
}

/** Resolve provider capability without inferring anything from its names. */
export async function resolveImageCapability(
  resolveInfo: ResolveModelInfo | undefined,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<ImageCapability> {
  return (await inspectImageCapability(resolveInfo, provider, model, signal)).capability
}

export async function isBridgedModel(
  resolveInfo: ResolveModelInfo | undefined,
  opts: Pick<VisionOptions, 'unknownCapabilityPolicy'>,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const inspection = await inspectImageCapability(resolveInfo, provider, model, signal)
  if (inspection.capability === 'native') return false
  if (inspection.capability === 'unsupported') return true
  // A resolver failure is not equivalent to a successful lookup that omitted
  // inputModalities. Preserve the adapter's error contract in either policy;
  // an auxiliary upload must never be a fail-open response to metadata I/O.
  if (inspection.failed) throw inspection.error
  // Undefined metadata after a successful lookup is intentionally different:
  // only the explicit policy may choose to bridge it. Never infer from names.
  if (opts.unknownCapabilityPolicy === 'bridge') return true
  return false
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function assertHttpEndpoint(baseURL: string): void {
  if (!isHttpUrl(baseURL)) {
    throw new VisionError(
      `vision baseURL must be an absolute http(s) URL, got "${baseURL || '(empty)'}"`,
      'VISION_INVALID_ENDPOINT',
    )
  }
  const url = new URL(baseURL)
  if (url.username !== '' || url.password !== '') {
    throw new VisionError('vision baseURL must not include credentials', 'VISION_INVALID_ENDPOINT')
  }
}

export function endpointFor(opts: Pick<VisionOptions, 'protocol' | 'baseURL'>): string {
  if (opts.protocol === 'anthropic') return `${opts.baseURL}/messages`
  if (opts.protocol === 'openai-chat') return `${opts.baseURL}/chat/completions`
  return `${opts.baseURL}/responses`
}

export function buildPrompt(
  opts: Pick<VisionOptions, 'prompt' | 'focusHint'>,
  focus: string,
): string {
  let prompt = opts.prompt
  if (focus.length > 0 && opts.focusHint) {
    if (prompt.includes('{focus}')) prompt = prompt.split('{focus}').join(focus)
    else prompt += `\n## 本次关注点\n${focus}`
  }
  return prompt
}

export function buildHeaders(
  opts: Pick<VisionOptions, 'protocol' | 'apiVersion'>,
  apiKey: string,
  userAgent = `dsh-vision/${VISION_PLUGIN_NAME}`,
): Record<string, string> {
  const base = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': userAgent,
  }
  if (opts.protocol === 'anthropic') {
    return {
      ...base,
      'x-api-key': apiKey,
      authorization: `Bearer ${apiKey}`,
      'anthropic-version': opts.apiVersion,
    }
  }
  return { ...base, authorization: `Bearer ${apiKey}` }
}

export function buildBody(
  opts: Pick<VisionOptions, 'protocol' | 'model' | 'effort' | 'maxTokens' | 'describeMaxTokens'>,
  prompt: string,
  mediaType: string,
  base64: string,
): Record<string, unknown> {
  if (opts.protocol === 'anthropic') {
    return {
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        ],
      }],
    }
  }
  if (opts.protocol === 'openai-chat') {
    return {
      model: opts.model,
      max_tokens: opts.describeMaxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        ],
      }],
    }
  }
  return {
    model: opts.model,
    ...(opts.effort.length > 0 ? { reasoning: { effort: opts.effort } } : {}),
    max_output_tokens: opts.describeMaxTokens,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:${mediaType};base64,${base64}` },
      ],
    }],
  }
}

export function extractText(protocol: VisionProtocol, data: unknown): string {
  if (protocol === 'anthropic') {
    const blocks = (data as { content?: unknown } | undefined)?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block): block is { type: 'text'; text: string } => (
        typeof block === 'object' && block !== null
        && (block as Record<string, unknown>).type === 'text'
        && typeof (block as Record<string, unknown>).text === 'string'
      ))
      .map(block => block.text)
      .join('\n')
      .trim()
  }
  if (protocol === 'openai-chat') {
    const choices = (data as { choices?: unknown } | undefined)?.choices
    if (!Array.isArray(choices)) return ''
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    return content
      .filter((block): block is { type: 'text'; text: string } => (
        typeof block === 'object' && block !== null
        && (block as Record<string, unknown>).type === 'text'
        && typeof (block as Record<string, unknown>).text === 'string'
      ))
      .map(block => block.text)
      .join('\n')
      .trim()
  }
  const output = (data as { output?: unknown } | undefined)?.output
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue
    const candidate = item as Record<string, unknown>
    if (candidate.type !== 'message' || !Array.isArray(candidate.content)) continue
    for (const block of candidate.content) {
      if (typeof block !== 'object' || block === null) continue
      const text = block as Record<string, unknown>
      if (text.type === 'output_text' && typeof text.text === 'string') parts.push(text.text)
    }
  }
  return parts.join('\n').trim()
}

/** Fail closed on a syntactically valid JSON value with the wrong protocol shape. */
export function assertResponseShape(protocol: VisionProtocol, data: unknown): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new VisionError('vision returned an invalid JSON response shape', 'VISION_PROVIDER_ERROR')
  }
  const record = data as Record<string, unknown>
  if (protocol === 'anthropic' && !Array.isArray(record.content)) {
    throw new VisionError('vision returned an invalid Anthropic response shape', 'VISION_PROVIDER_ERROR')
  }
  if (protocol === 'openai-chat' && !Array.isArray(record.choices)) {
    throw new VisionError('vision returned an invalid chat response shape', 'VISION_PROVIDER_ERROR')
  }
  if (protocol === 'openai-responses' && !Array.isArray(record.output)) {
    throw new VisionError('vision returned an invalid Responses response shape', 'VISION_PROVIDER_ERROR')
  }
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Stable plugin error with a machine-routable code. */
export class VisionError extends Error {
  readonly code: string
  readonly cause?: unknown

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'VisionError'
    this.code = code
    this.cause = options?.cause
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError'
}

export function visionAborted(signal: AbortSignal | undefined, fallback?: unknown): VisionError {
  return new VisionError('vision request aborted', 'VISION_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

export function abortableWait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(visionAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(visionAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}
