/**
 * dsh-vision — transparent image understanding for text-only models.
 *
 * The conversation model never changes provider or model.  The plugin only
 * checks each route's declared input capabilities and, when a text-only route
 * receives an image, asks a separately configured vision model for bounded
 * textual evidence. Capability admission is exposed through the
 * `imageInputAdmission` service; this plugin never mutates the provider's
 * native model metadata. Images are transformed only for the current model
 * dispatch through the `imageInputTransform` service. The `llm/stream` bridge
 * remains as a compatibility path for runtimes without that first-class
 * transform seam.
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { createRequire } from 'node:module'
import {
  DEFAULT_ANTHROPIC_API_VERSION,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CACHE_SIZE,
  DEFAULT_DESCRIBE_MAX_TOKENS,
  DEFAULT_MAX_EVIDENCE_CHARS,
  DEFAULT_MODEL,
  DEFAULT_PROTOCOL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UNKNOWN_CAPABILITY_POLICY,
  LEGACY_DEFAULT_API_KEY_ENV,
  LEGACY_VISION_PLUGIN_NAME,
  MAX_EVIDENCE_CHARS,
  MAX_FOCUS_CHARS,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MEDIA_TYPES,
  abortableWait,
  assertHttpEndpoint,
  assertResponseShape,
  buildBody,
  buildHeaders,
  buildPrompt,
  configFingerprint,
  contentHasImage,
  declaresImage,
  endpointFor,
  evidenceKey,
  extractFocus,
  extractText,
  isAbortError,
  isBridgedModel,
  isHttpUrl,
  resolveImageCapability,
  makeEvidenceCache,
  messagesContainImage,
  stableDigest,
  truncateText,
  visionAborted,
  VisionError,
  VISION_PLUGIN_NAME,
} from './core.ts'
import type {
  ContentBlock,
  EvidenceCache,
  EvidenceResult,
  ImageBlock,
  Message,
  ResolveModelInfo,
  VisionConfig,
  VisionModelInfo,
  VisionOptions,
  VisionProtocol,
  UnknownCapabilityPolicy,
  ImageCapability,
} from './core.ts'

export {
  DEFAULT_API_KEY_ENV,
  DEFAULT_UNKNOWN_CAPABILITY_POLICY,
  LEGACY_DEFAULT_API_KEY_ENV,
  LEGACY_VISION_PLUGIN_NAME,
  MAX_EVIDENCE_CHARS,
  MAX_FOCUS_CHARS,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  VisionError,
  VISION_PLUGIN_NAME,
  abortableWait,
  assertHttpEndpoint,
  assertResponseShape,
  buildBody,
  buildHeaders,
  buildPrompt,
  configFingerprint,
  contentHasImage,
  declaresImage,
  endpointFor,
  evidenceKey,
  extractFocus,
  extractText,
  isAbortError,
  isBridgedModel,
  isHttpUrl,
  resolveImageCapability,
  makeEvidenceCache,
  messagesContainImage,
  stableDigest,
  truncateText,
  visionAborted,
}
export type {
  ContentBlock,
  EvidenceCache,
  EvidenceResult,
  ImageCapability,
  ImageBlock,
  Message,
  ResolveModelInfo,
  VisionConfig,
  VisionModelInfo,
  VisionOptions,
  VisionProtocol,
  UnknownCapabilityPolicy,
}

export const name = '@dsh-desktop/vision'
export const inject = ['llm'] as const
export const NS = 'vision'
export const MARKER = '__dshVisionBridged'
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const VERSION = createRequire(import.meta.url)('../package.json').version as string
const USER_AGENT = `dsh-vision/${VERSION}`
const VISION_BASE_URL_ENV = 'DSH_VISION_BASE_URL'

export const DEFAULT_PROMPT = `请用中文把这张图片转成结构化证据，按以下分区输出：
## OCR 全文转录（逐字，保留换行与对话顺序）
## 版面与布局（按阅读顺序列出各区域：标题/段落/列表/表格/图表/表单/代码/图标，每区一句）
## 元素清单（按钮/控件/对象及大致位置）
## 图表数据（坐标轴、刻度、数值、图例，如适用）
## 视觉特征（主色、风格）
## 不确定项（看不清或无法判断的部分，如实说明）
只输出分区内容本身，不要复述指令。`

/** Settings schema. Legacy target fields remain parseable but are ignored. */
export const Config: z<VisionConfig> = z.object({
  enabled: z.boolean().default(true),
  protocol: z.union(['openai-responses', 'openai-chat', 'anthropic']).default(DEFAULT_PROTOCOL),
  /** Empty means not configured; the Host never guesses a provider endpoint. */
  baseURL: z.string().default(''),
  /**
   * Legacy escape hatch: old profiles may have selected a custom credential
   * reference.  Keep parsing and honoring that explicit value, but hide it
   * from settings surfaces now that the client uses the built-in reference.
   */
  apiKeyEnv: z.string().role('credential-ref').hidden().default(DEFAULT_API_KEY_ENV),
  model: z.string().default(DEFAULT_MODEL),
  prompt: z.string().default(DEFAULT_PROMPT),
  reasoningEffort: z.string().default(DEFAULT_REASONING_EFFORT),
  requestTimeoutMs: z.number().step(1).min(1).max(120_000).default(DEFAULT_TIMEOUT_MS),
  anthropicApiVersion: z.string().default(DEFAULT_ANTHROPIC_API_VERSION),
  anthropicMaxTokens: z.number().step(1).min(1).max(65_536).default(DEFAULT_ANTHROPIC_MAX_TOKENS),
  describeMaxTokens: z.number().step(1).min(1).max(65_536).default(DEFAULT_DESCRIBE_MAX_TOKENS),
  focusHint: z.boolean().default(true),
  unknownCapabilityPolicy: z.union(['passthrough', 'bridge']).default(DEFAULT_UNKNOWN_CAPABILITY_POLICY),
  // These fields are kept so old settings can be loaded during migration.
  // They are intentionally not projected into VisionOptions.
  upstream: z.string().default(''),
  families: z.array(z.string()).default([]),
  models: z.array(z.string()).default([]),
  cacheSize: z.number().step(1).min(1).max(256).default(DEFAULT_CACHE_SIZE),
  maxEvidenceChars: z.number().step(1).min(256).max(MAX_EVIDENCE_CHARS).default(DEFAULT_MAX_EVIDENCE_CHARS),
  maxImageBytes: z.number().step(1).min(1).max(MAX_IMAGE_BYTES).default(MAX_IMAGE_BYTES),
})

export const DEFAULT_CONFIG: Required<VisionConfig> = {
  enabled: true,
  protocol: DEFAULT_PROTOCOL,
  baseURL: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  model: DEFAULT_MODEL,
  prompt: DEFAULT_PROMPT,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  requestTimeoutMs: DEFAULT_TIMEOUT_MS,
  anthropicApiVersion: DEFAULT_ANTHROPIC_API_VERSION,
  anthropicMaxTokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
  describeMaxTokens: DEFAULT_DESCRIBE_MAX_TOKENS,
  focusHint: true,
  unknownCapabilityPolicy: DEFAULT_UNKNOWN_CAPABILITY_POLICY,
  upstream: '',
  families: [],
  models: [],
  cacheSize: DEFAULT_CACHE_SIZE,
  maxEvidenceChars: DEFAULT_MAX_EVIDENCE_CHARS,
  maxImageBytes: MAX_IMAGE_BYTES,
}

interface CredentialsService {
  /** Resolve the reference from the provider-owned secret store. */
  resolve: (ref: string) => Promise<{ value: string } | undefined>
}

interface LaunchEnvironment {
  get: (name: string) => { value: string } | undefined
}

/**
 * Read a launch-time value only when the credentials service is unavailable.
 * A mounted credentials provider already owns the complete precedence chain
 * (inherited environment, managed store, project `.env`, user `.env`), so a
 * second ambient lookup would be both redundant and capable of bypassing its
 * error/precedence contract. `launchEnvironmentOf()` itself supplies the
 * inherited-process snapshot for minimal hosts; reading `process.env` again
 * here would escape that immutable launch snapshot.
 */
function ambientValue(ctx: ContextLike, refName: string): string | undefined {
  const value = (launchEnvironmentOf(ctx as never) as unknown as LaunchEnvironment).get(refName)
  return value !== undefined && value.value.length > 0 ? value.value : undefined
}

/**
 * Keep the old built-in slot readable after the default changes.  A custom
 * (including explicitly selected `SELF_API_KEY`) reference is authoritative
 * and does not fall through to another slot; only the new built-in reference
 * gets the one-way compatibility fallback.
 */
function credentialRefs(primary: string): readonly string[] {
  return primary === DEFAULT_API_KEY_ENV
    ? [primary, LEGACY_DEFAULT_API_KEY_ENV]
    : [primary]
}

interface AttachmentRef {
  attachmentId?: string
  mediaType?: string
  bytes?: number
  [key: string]: unknown
}

interface StoredImage {
  data: Uint8Array | ArrayBuffer
  ref?: AttachmentRef
}

interface AttachmentsService {
  readImage: (ref: unknown, signal?: AbortSignal) => Promise<StoredImage>
}

interface LlmService {
  resolveModelInfo?: ResolveModelInfo
  stream?: (options: GenerateOptions) => AsyncIterable<unknown>
  /** Optional first-class seam supplied by newer LlmRuntime versions. */
  registerInputTransform?: (
    transform: (request: ImageInputTransformRequest) => ImageInputTransformResult | Promise<ImageInputTransformResult>,
  ) => () => void
}

interface GenerateOptions extends Record<string, unknown> {
  provider?: string
  model?: string
  messages?: readonly Message[]
  signal?: AbortSignal
}

interface ContextLike {
  get: (key: string) => unknown
  provide?: (key: string, service: unknown) => unknown
  on?: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => unknown
  effect?: (factory: () => void | (() => void | Promise<void>), name?: string) => unknown
}

interface VisionContext extends ContextLike {
  inject?: (services: readonly string[], callback: (ctx: ContextLike) => void) => unknown
}

export type ImageInputCapability = 'native' | 'text-only' | 'unknown'
export type ImageInputAdmissionResolution = 'resolved' | 'failed'
export type ImageInputAdmission = 'bridge' | 'abstain'

export interface ImageInputAdmissionRequest {
  provider: string
  model: string
  capability: ImageInputCapability
  resolution: ImageInputAdmissionResolution
  signal?: AbortSignal
}

export interface ImageInputAdmissionService {
  admit: (request: ImageInputAdmissionRequest) => ImageInputAdmission | Promise<ImageInputAdmission>
}

/**
 * A request-level image transformation. The returned array is a derived view
 * for one model dispatch; callers must retain the original session messages.
 * `inputModalities` is optional so the service can be used directly by older
 * callers. New dispatch seams should provide it (including `undefined` when
 * the provider has no capability declaration) to avoid a second lookup.
 */
export type ImageInputTransformResult = readonly Message[] | undefined

export interface ImageInputTransformRequest {
  provider: string
  model: string
  messages: readonly Message[]
  inputModalities?: readonly string[]
  signal?: AbortSignal
}

export interface ImageInputTransformService {
  transform: (request: ImageInputTransformRequest) => Promise<ImageInputTransformResult>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Reject malformed settings before they can strand a running image bridge. */
export function validateConfig(value: VisionConfig): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VisionError('vision settings must be an object', 'VISION_INVALID_CONFIG')
  }
  const protocol = value.protocol ?? DEFAULT_PROTOCOL
  if (protocol !== 'openai-responses' && protocol !== 'openai-chat' && protocol !== 'anthropic') {
    throw new VisionError(`unsupported vision protocol "${String(protocol)}"`, 'VISION_INVALID_CONFIG')
  }
  const baseURL = value.baseURL ?? ''
  if (baseURL !== '') {
    assertHttpEndpoint(baseURL)
  }
  const apiKeyEnv = value.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  if (!isCredentialRefName(apiKeyEnv)) {
    throw new VisionError(`invalid credential reference "${apiKeyEnv}"`, 'VISION_INVALID_CONFIG')
  }
  const model = value.model ?? DEFAULT_MODEL
  if (model.trim() === '' || model.length > 256) {
    throw new VisionError('vision model must be a non-empty string of at most 256 characters', 'VISION_INVALID_CONFIG')
  }
  const unknownCapabilityPolicy = value.unknownCapabilityPolicy ?? DEFAULT_UNKNOWN_CAPABILITY_POLICY
  if (unknownCapabilityPolicy !== 'passthrough' && unknownCapabilityPolicy !== 'bridge') {
    throw new VisionError('vision unknown capability policy must be "passthrough" or "bridge"', 'VISION_INVALID_CONFIG')
  }
  const prompt = value.prompt ?? DEFAULT_PROMPT
  if (prompt.trim() === '' || prompt.length > MAX_PROMPT_CHARS) {
    throw new VisionError(`vision prompt must contain 1-${MAX_PROMPT_CHARS} characters`, 'VISION_INVALID_CONFIG')
  }
  const timeout = value.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = value.anthropicMaxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS
  const describeTokens = value.describeMaxTokens ?? DEFAULT_DESCRIBE_MAX_TOKENS
  const cacheSize = value.cacheSize ?? DEFAULT_CACHE_SIZE
  const evidenceChars = value.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
  const imageBytes = value.maxImageBytes ?? MAX_IMAGE_BYTES
  if (![timeout, maxTokens, describeTokens, cacheSize, evidenceChars, imageBytes].every(Number.isSafeInteger)) {
    throw new VisionError('vision numeric settings must be safe integers', 'VISION_INVALID_CONFIG')
  }
  if (timeout < 1 || timeout > 120_000 || maxTokens < 1 || maxTokens > 65_536
    || describeTokens < 1 || describeTokens > 65_536 || cacheSize < 1 || cacheSize > 256
    || evidenceChars < 256 || evidenceChars > MAX_EVIDENCE_CHARS || imageBytes < 1 || imageBytes > MAX_IMAGE_BYTES) {
    throw new VisionError('vision numeric settings are outside their supported bounds', 'VISION_INVALID_CONFIG')
  }
}

export function resolveOptions(ctx: ContextLike, config: VisionConfig = DEFAULT_CONFIG): VisionOptions {
  const merged = { ...DEFAULT_CONFIG, ...config }
  const apiKeyEnvName = isCredentialRefName(stringValue(merged.apiKeyEnv, DEFAULT_API_KEY_ENV))
    ? stringValue(merged.apiKeyEnv, DEFAULT_API_KEY_ENV)
    : DEFAULT_API_KEY_ENV
  const apiKeyEnv = credentialRef(apiKeyEnvName)
  const apiKeyRefs = credentialRefs(apiKeyEnvName).map(ref => credentialRef(ref))
  const baseURL = stringValue(merged.baseURL, '')
    || ambientValue(ctx, VISION_BASE_URL_ENV)
    || ''
  const protocol = merged.protocol === 'openai-chat' || merged.protocol === 'anthropic'
    ? merged.protocol
    : DEFAULT_PROTOCOL
  return {
    enabled: booleanValue(merged.enabled, true),
    protocol,
    baseURL: baseURL.replace(/\/+$/u, ''),
    apiKeyEnv: apiKeyEnv as string,
    model: stringValue(merged.model, DEFAULT_MODEL),
    prompt: stringValue(merged.prompt, DEFAULT_PROMPT),
    effort: stringValue(merged.reasoningEffort, DEFAULT_REASONING_EFFORT),
    timeoutMs: integerValue(merged.requestTimeoutMs, DEFAULT_TIMEOUT_MS),
    apiVersion: stringValue(merged.anthropicApiVersion, DEFAULT_ANTHROPIC_API_VERSION),
    maxTokens: integerValue(merged.anthropicMaxTokens, DEFAULT_ANTHROPIC_MAX_TOKENS),
    describeMaxTokens: integerValue(merged.describeMaxTokens, DEFAULT_DESCRIBE_MAX_TOKENS),
    focusHint: booleanValue(merged.focusHint, true),
    unknownCapabilityPolicy: merged.unknownCapabilityPolicy === 'bridge'
      ? 'bridge'
      : DEFAULT_UNKNOWN_CAPABILITY_POLICY,
    cacheSize: integerValue(merged.cacheSize, DEFAULT_CACHE_SIZE),
    maxEvidenceChars: integerValue(merged.maxEvidenceChars, DEFAULT_MAX_EVIDENCE_CHARS),
    maxImageBytes: Math.min(integerValue(merged.maxImageBytes, MAX_IMAGE_BYTES), MAX_IMAGE_BYTES),
    resolveApiKey: async () => {
      let credentials: CredentialsService | undefined
      try {
        credentials = ctx.get('credentials') as CredentialsService | undefined
      } catch {
        credentials = undefined
      }
      if (credentials !== undefined) {
        // The mounted credentials provider owns the complete resolution
        // precedence chain.  Do not silently fall back to ambient values when
        // it reports an error or an unset reference: that would bypass its
        // trust ordering and make a managed credential unexpectedly lose to a
        // process/.env value.
        for (const ref of apiKeyRefs) {
          const value = (await credentials.resolve(ref))?.value
          if (typeof value === 'string' && value.length > 0) return value
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

/** Strip the Cordis traceable proxy without losing the method receiver. */
export function unwrapService<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value
  const raw = (value as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL]
  return (raw === undefined ? value : raw) as T
}

function bytesOf(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function mediaTypeOf(stored: StoredImage, block: ImageBlock): string {
  const blockRef = asRecord(block.attachment)
  const value = stored.ref?.mediaType ?? blockRef?.mediaType
  if (typeof value !== 'string') throw new VisionError('image attachment has no media type', 'VISION_INVALID_IMAGE')
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!(mediaType in MEDIA_TYPES)) {
    throw new VisionError(`unsupported image media type ${mediaType || '(none)'}`, 'VISION_INVALID_IMAGE')
  }
  return mediaType
}

function bodyByteLength(body: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(body, 'utf8') : new TextEncoder().encode(body).byteLength
}

interface FetchedJson {
  response: Response
  signal: AbortSignal
  timeoutSignal: AbortSignal
}

export async function readLimitedBody(
  response: Response,
  signal: AbortSignal,
  subject: string,
  timeoutSignal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BODY_BYTES) {
    throw new VisionError(`vision ${subject} body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`, 'VISION_RESPONSE_TOO_LARGE')
  }
  if (signal.aborted) {
    if (timeoutSignal?.aborted === true) {
      throw new VisionError('vision request timed out while reading the response', 'VISION_PROVIDER_TIMEOUT')
    }
    throw visionAborted(signal)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (timeoutSignal?.aborted === true) {
        throw new VisionError('vision request timed out while reading the response', 'VISION_PROVIDER_TIMEOUT', { cause: error })
      }
      if (signal.aborted) throw visionAborted(signal, error)
      throw new VisionError(`vision ${subject} body read failed: ${String(error)}`, 'VISION_PROVIDER_ERROR', { cause: error })
    }
    if (bodyByteLength(text) > MAX_RESPONSE_BODY_BYTES) {
      throw new VisionError(`vision ${subject} body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`, 'VISION_RESPONSE_TOO_LARGE')
    }
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) {
        if (timeoutSignal?.aborted === true) {
          throw new VisionError('vision request timed out while reading the response', 'VISION_PROVIDER_TIMEOUT')
        }
        throw visionAborted(signal)
      }
      const part = await reader.read()
      if (part.done) break
      const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value)
      total += chunk.byteLength
      if (total > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel()
        throw new VisionError(`vision ${subject} body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`, 'VISION_RESPONSE_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof VisionError) throw error
    if (timeoutSignal?.aborted === true) {
      throw new VisionError('vision request timed out while reading the response', 'VISION_PROVIDER_TIMEOUT', { cause: error })
    }
    if (signal.aborted || isAbortError(error)) throw visionAborted(signal, error)
    throw new VisionError(`vision ${subject} body read failed: ${String(error)}`, 'VISION_PROVIDER_ERROR', { cause: error })
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function readJson(fetched: FetchedJson, subject: string): Promise<unknown> {
  const text = await readLimitedBody(fetched.response, fetched.signal, subject, fetched.timeoutSignal)
  if (!fetched.response.ok) {
    let detail = `HTTP ${fetched.response.status}`
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = asRecord(parsed.error)
      const candidate = typeof parsed.error === 'string' ? parsed.error : error?.message ?? parsed.message
      if (typeof candidate === 'string' && candidate.length > 0) detail = truncateText(candidate, 1_000)
    } catch {
      // Preserve only the HTTP status for malformed error bodies.
    }
    throw new VisionError(`vision upstream error: ${detail}`, 'VISION_PROVIDER_ERROR')
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new VisionError(`vision returned an unprocessable response body: ${String(error)}`, 'VISION_PROVIDER_ERROR', { cause: error })
  }
}

async function resolveApiKey(opts: VisionOptions): Promise<string> {
  const value = await opts.resolveApiKey?.()
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VisionError(`no API key for "${opts.apiKeyEnv}"; check the vision configuration`, 'VISION_CREDENTIAL_MISSING')
  }
  const normalized = value.trim()
  if (!/^[\x21-\x7E]+$/u.test(normalized)) {
    throw new VisionError(
      'vision credential contains characters that cannot be used in an HTTP header',
      'VISION_CREDENTIAL_INVALID',
    )
  }
  return normalized
}

export async function describeBytes(
  opts: VisionOptions,
  data: Uint8Array | ArrayBuffer,
  mediaType: string,
  focus = '',
  signal?: AbortSignal,
): Promise<string> {
  assertHttpEndpoint(opts.baseURL)
  const bytes = bytesOf(data)
  if (bytes.byteLength === 0) throw new VisionError('empty image data', 'VISION_INVALID_IMAGE')
  if (bytes.byteLength > opts.maxImageBytes || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new VisionError(`image exceeds ${opts.maxImageBytes} bytes`, 'VISION_INVALID_IMAGE')
  }
  if (!(mediaType in MEDIA_TYPES)) {
    throw new VisionError(`unsupported image media type ${mediaType}`, 'VISION_INVALID_IMAGE')
  }
  if (signal?.aborted === true) throw visionAborted(signal)
  const base64 = Buffer.from(bytes).toString('base64')
  const body = buildBody(opts, buildPrompt(opts, focus), mediaType, base64)
  const fetched = await fetchJsonWithKey(opts, body, signal)
  const parsed = await readJson(fetched, 'vision response')
  assertResponseShape(opts.protocol, parsed)
  const text = truncateText(extractText(opts.protocol, parsed), opts.maxEvidenceChars)
  if (text.length === 0) throw new VisionError('vision model returned no text', 'VISION_EMPTY')
  return text
}

/** Fetch wrapper that resolves credentials exactly once per operation. */
async function fetchJsonWithKey(
  opts: VisionOptions,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FetchedJson> {
  assertHttpEndpoint(opts.baseURL)
  const encoded = JSON.stringify(body)
  if (bodyByteLength(encoded) > MAX_REQUEST_BODY_BYTES) {
    throw new VisionError(`vision request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`, 'VISION_REQUEST_TOO_LARGE')
  }
  const key = await abortableWait(resolveApiKey(opts), signal)
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs)
  const fused = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
  let response: Response
  try {
    response = await fetch(endpointFor(opts), {
      method: 'POST',
      redirect: 'error',
      headers: buildHeaders(opts, key, USER_AGENT),
      body: encoded,
      signal: fused,
    })
  } catch (error) {
    if (signal?.aborted === true) throw visionAborted(signal, error)
    if (timeoutSignal.aborted) {
      throw new VisionError(`vision request timed out after ${opts.timeoutMs}ms`, 'VISION_PROVIDER_TIMEOUT', { cause: error })
    }
    if (isAbortError(error)) throw visionAborted(signal, error)
    throw new VisionError(`vision request failed: ${String(error)}`, 'VISION_PROVIDER_ERROR', { cause: error })
  }
  return { response, signal: fused, timeoutSignal }
}

async function describeAttachment(
  opts: VisionOptions,
  attachments: AttachmentsService,
  block: ImageBlock,
  focus: string,
  signal?: AbortSignal,
): Promise<string> {
  const stored = await abortableWait(attachments.readImage(block.attachment, signal), signal)
  if (stored === undefined || stored.data === undefined) {
    throw new VisionError('image attachment has no data', 'VISION_INVALID_IMAGE')
  }
  const mediaType = mediaTypeOf(stored, block)
  return describeBytes(opts, stored.data, mediaType, focus, signal)
}

function failureResult(error: unknown): EvidenceResult {
  if (error instanceof VisionError && error.code === 'VISION_ABORTED') throw error
  return { ok: false, text: '', error }
}

function failureText(result: EvidenceResult): string {
  const message = result.error instanceof Error ? result.error.message : String(result.error ?? 'unknown error')
  return `[图片未能由视觉模型转写：${truncateText(message, 300)}。请检查 vision 配置。]`
}

interface RewriteState {
  opts: VisionOptions
  attachments: AttachmentsService
  cache: EvidenceCache
  focus: string
  signal?: AbortSignal
}

async function imageBlockResult(block: ImageBlock, state: RewriteState): Promise<EvidenceResult & { key: string }> {
  const key = evidenceKey(block, state.opts)
  const existing = state.cache.get(key)
  if (existing !== undefined) return { key, ...(await abortableWait(existing, state.signal)) }
  const pending = describeAttachment(state.opts, state.attachments, block, state.focus, state.signal).then(
    text => ({ ok: true, text } satisfies EvidenceResult),
    error => failureResult(error),
  )
  state.cache.set(key, pending)
  const result = await abortableWait(pending, state.signal)
  if (!result.ok && state.cache.peek(key) === pending) state.cache.deleteKey(key)
  return { key, ...result }
}

async function rewriteBlock(block: ContentBlock, state: RewriteState): Promise<ContentBlock> {
  if (typeof block !== 'object' || block === null) return block
  const candidate = block as Record<string, unknown>
  if (candidate.type === 'image') {
    const result = await imageBlockResult(candidate as unknown as ImageBlock, state)
    return {
      type: 'text',
      text: result.ok ? `[图片证据]\n${result.text}` : failureText(result),
    }
  }
  if (candidate.type === 'tool-result' && Array.isArray(candidate.content)) {
    const content = await mapWithConcurrency(candidate.content as ContentBlock[], 2, inner => rewriteBlock(inner, state))
    return { ...candidate, content }
  }
  return block
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const result = Array.from<R | undefined>({ length: items.length }) as R[]
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      result[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()))
  return result
}

export async function rewriteMessages(
  opts: VisionOptions,
  attachments: AttachmentsService,
  cache: EvidenceCache,
  messages: readonly Message[],
  focus = '',
  signal?: AbortSignal,
): Promise<Message[]> {
  const state: RewriteState = {
    opts,
    attachments,
    cache,
    focus: focus.slice(0, MAX_FOCUS_CHARS),
    signal,
  }
  return mapWithConcurrency(messages, 2, async message => {
    if (!Array.isArray(message.content) || !contentHasImage(message.content)) return message
    const content = await mapWithConcurrency(message.content, 2, block => rewriteBlock(block, state))
    return { ...message, content }
  })
}

/** Only advertise the bridge when a request could reach its auxiliary model. */
function bridgeConfigured(opts: VisionOptions): boolean {
  return opts.enabled && isHttpUrl(opts.baseURL) && opts.model.trim().length > 0
}

/**
 * Register the first-class admission decision used by the API proxy.
 *
 * This service only decides what to do with a capability result supplied by
 * the proxy. It never inspects provider/model names and never claims native
 * image support. Unknown capabilities remain pass-through by default; the
 * explicit bridge policy opts in only when the auxiliary bridge is ready.
 */
export function installImageInputAdmission(
  ctx: ContextLike,
  getOptions: () => VisionOptions,
): void {
  if (ctx.provide === undefined) return
  const service: ImageInputAdmissionService = {
    admit: ({ capability, resolution }) => {
      const opts = getOptions()
      if (!opts.enabled) return 'abstain'
      if (!bridgeConfigured(opts)) return 'abstain'
      // A failed capability lookup belongs to the host's original error
      // contract. The unknown policy only covers successful lookups whose
      // metadata omitted inputModalities.
      if (resolution === 'failed') return 'abstain'
      if (capability === 'text-only') return 'bridge'
      return capability === 'unknown' && opts.unknownCapabilityPolicy === 'bridge'
        ? 'bridge'
        : 'abstain'
    },
  }
  ctx.provide('imageInputAdmission', service)
}

/**
 * Register the request-level image transformation used by a first-class
 * dispatch seam. The returned messages are ephemeral: callers must not append
 * them to the session or replace the durable user message.
 *
 * If the seam already resolved model capabilities, it should pass the
 * `inputModalities` property (including `undefined`) so this service does not
 * resolve the same route a second time. Older callers may omit the property;
 * in that case the receiver-safe resolver is used as a compatibility adapter.
 */
export function installImageInputTransform(
  ctx: ContextLike,
  getOptions: () => VisionOptions,
  cache: EvidenceCache,
  resolveInfo: ResolveModelInfo | undefined,
): boolean {
  if (ctx.provide === undefined) return false
  const service: ImageInputTransformService = {
    transform: async request => {
      if (!Array.isArray(request.messages) || !messagesContainImage(request.messages)) return undefined
      if (request.provider.trim() === '' || request.model.trim() === '') return undefined
      const opts = getOptions()
      if (request.signal?.aborted === true) throw visionAborted(request.signal)
      if (!bridgeConfigured(opts)) return undefined

      // A formal dispatch seam supplies the exact metadata it already looked
      // up. Checking property presence lets an explicit undefined mean
      // "capability not declared" instead of causing a duplicate lookup.
      const hasModalities = Object.prototype.hasOwnProperty.call(request, 'inputModalities')
      const bridged = hasModalities
        ? (() => {
            const capability = Array.isArray(request.inputModalities)
              ? declaresImage({ inputModalities: request.inputModalities }) ? 'native' : 'unsupported'
              : 'unknown'
            if (capability === 'native') return false
            if (capability === 'unsupported') return true
            return opts.unknownCapabilityPolicy === 'bridge'
          })()
        : await isBridgedModel(resolveInfo, opts, request.provider, request.model, request.signal)
      if (!bridged) return undefined

      const attachments = ctx.get('attachments') as AttachmentsService | undefined
      if (attachments === undefined) return undefined
      const focus = opts.focusHint ? extractFocus(request.messages) : ''
      return rewriteMessages(opts, attachments, cache, request.messages, focus, request.signal)
    },
  }
  ctx.provide('imageInputTransform', service)

  // Newer runtimes own the dispatch lifecycle and can apply this derived view
  // before adapter generation. Keep registration on the traceable LlmRuntime
  // proxy so its lifecycle instrumentation remains intact. The stream listener
  // is installed only when this seam is unavailable.
  const llm = ctx.get('llm') as LlmService | undefined
  if (typeof llm?.registerInputTransform !== 'function') return false
  // A present-but-broken seam is a programming error and must surface;
  // only an absent method selects the legacy stream fallback.
  const dispose = llm.registerInputTransform.call(llm, service.transform)
  // 0011 的 fiber-owned 指 LlmRuntime 侧的注册簿记；返回的 disposer 是唯一
  // 移除入口，挂回本插件 fiber 的 effect，卸载/重载时一并释放。
  ctx.effect?.(() => () => { dispose() }, 'dsh-vision: input transform')
  return true
}

/**
 * Read the raw model-info resolver without changing the LLM runtime.
 *
 * The resolver is called only after an image is present in a request. Keeping
 * it as a bound structural adapter preserves the receiver expected by DSH's
 * LlmRuntime while leaving native capability metadata untouched. The Host
 * admission service is separate; this lookup revalidates the current route at
 * transformation time.
 */
export function getModelInfoResolver(ctx: ContextLike): ResolveModelInfo | undefined {
  const llm = ctx.get('llm') as LlmService | undefined
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined
  const raw = unwrapService(llm) as LlmService
  if (typeof raw.resolveModelInfo !== 'function') return undefined
  const original = raw.resolveModelInfo
  return (provider, model, signal) => original.call(raw, provider, model, signal)
}

/**
 * Install the compatibility stream rewrite for runtimes without a first-class
 * input-transform caller. Requests that already went through the transform
 * service contain no image and therefore stop here; MARKER prevents recursive
 * interception when the compatibility path has to re-enter `llm/stream`.
 */
export function installBridge(
  ctx: ContextLike,
  getOptions: () => VisionOptions,
  cache: EvidenceCache,
  resolveInfo?: ResolveModelInfo,
): void {
  const llm = ctx.get('llm') as LlmService | undefined
  if (llm?.stream === undefined || ctx.on === undefined) return
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<unknown>) => {
    const opts = getOptions()
    if (!bridgeConfigured(opts) || options[MARKER] === true) return next()
    if (typeof options.provider !== 'string' || typeof options.model !== 'string') return next()
    if (!Array.isArray(options.messages) || !messagesContainImage(options.messages)) return next()
    const attachments = ctx.get('attachments') as AttachmentsService | undefined
    if (attachments === undefined) return next()
    return (async function* (): AsyncGenerator<unknown> {
      const bridged = await isBridgedModel(resolveInfo, opts, options.provider as string, options.model as string, options.signal)
      if (!bridged) {
        yield* next()
        return
      }
      const focus = opts.focusHint ? extractFocus(options.messages ?? []) : ''
      const messages = await rewriteMessages(opts, attachments, cache, options.messages ?? [], focus, options.signal)
      yield* llm.stream?.({ ...options, messages, [MARKER]: true }) ?? next()
    })()
  })
}

/** 0.1.2 SettingsProvider.installSection 的最小结构面（仅本插件触碰的部分）。 */
interface SettingsHost {
  installSection(
    owner: unknown,
    ns: typeof NS,
    schema: typeof Config,
    entry: VisionConfig,
    hooks: {
      validate?: (value: VisionConfig) => void
      setSource: (source: () => VisionConfig) => void
      onChange: () => void
    },
  ): void
}

/** Main Host-side plugin. */
export function apply(ctx: VisionContext, config?: VisionConfig): void {
  const base: VisionConfig = { ...DEFAULT_CONFIG, ...config }
  validateConfig(base)
  let current: () => VisionConfig = () => base
  const cache = makeEvidenceCache(() => resolveOptions(ctx, current()).cacheSize)
  // 0.1.2 迁移：installSettingsSection 模块函数已移除，等价改用
  // SettingsProvider 实例方法 installSection；settings 为可选服务，
  // 缺席时保持组合配置（与旧 API 的回退语义一致）。
  const settings = ctx.get('settings') as SettingsHost | undefined
  settings?.installSection(ctx, NS, Config, base, {
    setSource: source => { current = source as () => VisionConfig },
    validate: value => { validateConfig(value) },
    onChange: () => {
      cache.clear()
    },
  })
  const getOptions = (): VisionOptions => resolveOptions(ctx, current())
  installImageInputAdmission(ctx, getOptions)
  const resolveInfo = getModelInfoResolver(ctx)
  const registered = installImageInputTransform(ctx, getOptions, cache, resolveInfo)
  if (!registered) installBridge(ctx, getOptions, cache, resolveInfo)
  ctx.effect?.(() => () => cache.clear(), 'dsh-vision: evidence cache')
}
