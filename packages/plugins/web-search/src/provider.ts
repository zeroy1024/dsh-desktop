/**
 * Provider-private wire implementation for the desktop web-search bridge.
 *
 * This file deliberately talks to the configured auxiliary model endpoint
 * directly.  It never calls `ctx.llm`: the model selected by the user remains
 * the caller of dsh-tool-web, while this provider supplies only the search
 * capability behind that tool.
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider as WebSearchProviderContract,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Wire protocols supported by the auxiliary search model. */
export type SearchProtocol = 'openai-responses' | 'anthropic'

/** Hard upper bound for an untrusted auxiliary response body. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Upper bound for one search query sent to the auxiliary model. */
export const MAX_QUERY_CHARS = 8_192

/** Upper bound for one URL carried by a structured citation. */
export const MAX_SOURCE_URL_CHARS = 8_192

/** Upper bound for a source title/snippet supplied by the upstream. */
export const MAX_SOURCE_FIELD_CHARS = 16_384

/** Upper bound for the optional provider-generated content field. */
export const MAX_CONTENT_CHARS = 100_000

/** Internal provider options after the Host settings layer has been resolved. */
export interface WebSearchProviderOptions {
  readonly enabled: boolean
  readonly protocol: SearchProtocol
  readonly baseURL: string
  readonly model: string
  readonly effort: string
  readonly timeoutMs: number
  readonly apiVersion: string
  readonly maxTokens: number
  readonly maxUses: number
  readonly apiKeyEnv?: string
  readonly apiKey?: string
  readonly resolveApiKey?: () => Promise<string | undefined>
  /**
   * Kept as an internal test seam only.  The Host `resolveOptions` function
   * always supplies {@link DEFAULT_PROMPT}; it is not part of user settings.
   */
  readonly prompt?: string
}

/** Product prompt.  It is intentionally not exposed as a settings field. */
export const DEFAULT_PROMPT = 'Perform a web search for the query: {query}'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const API_KEY_PATTERN = /^[\x21-\x7E]+$/u

/** Whether a value is an absolute HTTP(S) URL without embedded credentials. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username.length === 0
      && url.password.length === 0
  } catch {
    return false
  }
}

/** Whether an environment-style credential reference can be resolved safely. */
export function isCredentialRefName(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value)
}

/** Whether a numeric option is a positive safe integer. */
export function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** Replace the fixed product placeholder with one validated query. */
export function buildSearchPrompt(query: string, template = DEFAULT_PROMPT): string {
  return template.includes('{query}')
    ? template.split('{query}').join(query)
    : `${template} ${query}`
}

function providerError(message: string, cause?: unknown): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })
}

function responseShapeError(message: string): WebError {
  return new WebError(`web search returned an invalid response: ${message}`, 'WEB_PROVIDER_ERROR')
}

function responseTooLarge(limit: number): WebError {
  return new WebError(`web search response exceeds the maximum of ${limit} bytes`, 'WEB_PROVIDER_RESPONSE_TOO_LARGE')
}

function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('web search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Normalize a header-bound credential before fetch can fail opaquely. */
function usableApiKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new WebError('web search credential is empty', 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
  if (!API_KEY_PATTERN.test(normalized)) {
    throw new WebError(
      'web search credential contains characters that cannot be used in an HTTP header',
      'WEB_PROVIDER_CREDENTIAL_INVALID',
    )
  }
  return normalized
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/**
 * Race an async operation against cancellation while observing the operation's
 * eventual rejection.  The latter matters for response-body readers that do
 * not immediately stop when their signal fires.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(searchAborted(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function asRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw responseShapeError(`${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) throw responseShapeError(`${subject} must be an array`)
  return value
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  subject: string,
  maxLength = MAX_SOURCE_FIELD_CHARS,
): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw responseShapeError(`${subject}.${key} must be a non-empty string`)
  }
  if (value.length > maxLength) throw responseTooLarge(MAX_RESPONSE_BYTES)
  return value
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  subject: string,
  maxLength = MAX_SOURCE_FIELD_CHARS,
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw responseShapeError(`${subject}.${key} must be a string`)
  if (value.length > maxLength) throw responseTooLarge(MAX_RESPONSE_BYTES)
  return value.length > 0 ? value : undefined
}

function sourceUrl(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw responseShapeError(`${subject}.url must be a non-empty string`)
  }
  if (value.length > MAX_SOURCE_URL_CHARS || !isHttpUrl(value)) {
    throw responseShapeError(`${subject}.url must be an absolute http(s) URL`)
  }
  // URL fragments identify a client-side location, not a separate source.
  // Removing them also prevents one page from consuming the source budget many
  // times when an upstream emits several anchored citations.
  const hash = value.indexOf('#')
  return hash === -1 ? value : value.slice(0, hash)
}

function sourceFromRecord(record: Record<string, unknown>, subject: string): WebSearchSource {
  const url = sourceUrl(record.url, subject)
  const title = optionalString(record, 'title', subject)
  const snippet = optionalString(record, 'snippet', subject)
  const publishedAt = optionalString(record, 'page_age', subject)
    ?? optionalString(record, 'publishedAt', subject)
  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  }
}

/** Add a source and merge later structured metadata for the same URL. */
function addSource(sources: WebSearchSource[], next: WebSearchSource): void {
  const existingIndex = sources.findIndex(source => sourceKey(source.url) === sourceKey(next.url))
  if (existingIndex === -1) {
    sources.push(next)
    return
  }
  const existing = sources[existingIndex]!
  sources[existingIndex] = {
    ...existing,
    ...(existing.title === undefined && next.title !== undefined ? { title: next.title } : {}),
    ...(existing.snippet === undefined && next.snippet !== undefined ? { snippet: next.snippet } : {}),
    ...(existing.publishedAt === undefined && next.publishedAt !== undefined
      ? { publishedAt: next.publishedAt }
      : {}),
  }
}

function sourceKey(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    // The URL API normalizes an omitted root slash; treating both spellings as
    // one source prevents duplicate citations without rewriting the URL the
    // upstream supplied in the returned result.
    return parsed.toString()
  } catch {
    return url
  }
}

function citationSnippet(text: string, annotation: Record<string, unknown>, subject: string): string | undefined {
  const start = annotation.start_index
  const end = annotation.end_index
  if (start === undefined && end === undefined) return undefined
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || (start as number) < 0 || (end as number) < (start as number)
    || (end as number) > text.length) {
    throw responseShapeError(`${subject}.start_index/end_index are out of range`)
  }
  const snippet = text.slice(start as number, end as number).trim()
  return snippet.length > 0 ? snippet : undefined
}

/** Parse the structured source/citation vocabulary of OpenAI Responses. */
export function mapResponsesResponse(payload: unknown): WebSearchResult {
  const data = asRecord(payload, 'response')
  const output = asArray(data.output, 'response.output')
  const sources: WebSearchSource[] = []
  const textParts: string[] = []

  for (const [itemIndex, itemValue] of output.entries()) {
    const item = asRecord(itemValue, `response.output[${itemIndex}]`)
    const type = item.type
    if (typeof type !== 'string') throw responseShapeError(`response.output[${itemIndex}].type must be a string`)

    if (type === 'message') {
      const content = asArray(item.content, `response.output[${itemIndex}].content`)
      for (const [contentIndex, contentValue] of content.entries()) {
        const contentItem = asRecord(contentValue, `response.output[${itemIndex}].content[${contentIndex}]`)
        if (contentItem.type !== 'output_text') continue
        const text = requiredString(
          contentItem,
          'text',
          `response.output[${itemIndex}].content[${contentIndex}]`,
          MAX_CONTENT_CHARS,
        )
        textParts.push(text)
        if (textParts.join('\n\n').length > MAX_CONTENT_CHARS) {
          throw responseTooLarge(MAX_RESPONSE_BYTES)
        }
        const annotationsValue = contentItem.annotations
        if (annotationsValue === undefined) continue
        const annotations = asArray(
          annotationsValue,
          `response.output[${itemIndex}].content[${contentIndex}].annotations`,
        )
        for (const [annotationIndex, annotationValue] of annotations.entries()) {
          const annotation = asRecord(
            annotationValue,
            `response.output[${itemIndex}].content[${contentIndex}].annotations[${annotationIndex}]`,
          )
          if (annotation.type !== 'url_citation') continue
          const subject = `response.output[${itemIndex}].content[${contentIndex}].annotations[${annotationIndex}]`
          const url = sourceUrl(annotation.url, subject)
          const title = optionalString(annotation, 'title', subject)
          const snippet = citationSnippet(text, annotation, subject)
          addSource(sources, {
            url,
            ...(title === undefined ? {} : { title }),
            ...(snippet === undefined ? {} : { snippet }),
          })
        }
      }
      continue
    }

    if (type !== 'web_search_call') continue
    const action = asRecord(item.action, `response.output[${itemIndex}].action`)
    if (action.type === 'search') {
      const actionSources = action.sources
      if (actionSources === undefined) continue
      for (const [sourceIndex, sourceValue] of asArray(
        actionSources,
        `response.output[${itemIndex}].action.sources`,
      ).entries()) {
        const source = asRecord(sourceValue, `response.output[${itemIndex}].action.sources[${sourceIndex}]`)
        if (source.type !== 'url') continue
        addSource(sources, sourceFromRecord(source, `response.output[${itemIndex}].action.sources[${sourceIndex}]`))
      }
      continue
    }
    if (action.type === 'open_page') {
      const subject = `response.output[${itemIndex}].action`
      addSource(sources, { url: sourceUrl(action.url, subject) })
      continue
    }
    throw responseShapeError(`response.output[${itemIndex}].action.type is unsupported`)
  }

  if (sources.length === 0) {
    throw new WebError(
      'web search response contained no structured citations or consulted sources',
      'WEB_PROVIDER_ERROR',
    )
  }
  const content = textParts.join('\n\n')
  return {
    sources,
    truncated: false,
    ...(content.length === 0 ? {} : { content }),
  }
}

function citationMap(blocks: readonly unknown[]): Map<string, string> {
  const snippets = new Map<string, string>()
  for (const [blockIndex, blockValue] of blocks.entries()) {
    const block = asRecord(blockValue, `response.content[${blockIndex}]`)
    if (block.type !== 'text') continue
    const text = requiredString(block, 'text', `response.content[${blockIndex}]`, MAX_CONTENT_CHARS)
    const citationsValue = block.citations
    if (citationsValue === undefined) continue
    for (const [citationIndex, citationValue] of asArray(
      citationsValue,
      `response.content[${blockIndex}].citations`,
    ).entries()) {
      const citation = asRecord(
        citationValue,
        `response.content[${blockIndex}].citations[${citationIndex}]`,
      )
      const url = sourceUrl(citation.url, `response.content[${blockIndex}].citations[${citationIndex}]`)
      const citedText = requiredString(
        citation,
        'cited_text',
        `response.content[${blockIndex}].citations[${citationIndex}]`,
        MAX_SOURCE_FIELD_CHARS,
      )
      if (!snippets.has(url)) snippets.set(url, citedText)
      // Reading `text` above is intentional: it validates the block even when
      // a provider sends citations before its result blocks.
      void text
    }
  }
  return snippets
}

/** Parse the structured source vocabulary of Anthropic Messages. */
export function mapAnthropicResponse(payload: unknown): WebSearchResult {
  const data = asRecord(payload, 'response')
  const blocks = asArray(data.content, 'response.content')
  const snippets = citationMap(blocks)
  const sources: WebSearchSource[] = []
  const textParts: string[] = []
  let resultBlockCount = 0

  for (const [blockIndex, blockValue] of blocks.entries()) {
    const block = asRecord(blockValue, `response.content[${blockIndex}]`)
    if (block.type === 'text') {
      const text = requiredString(block, 'text', `response.content[${blockIndex}]`, MAX_CONTENT_CHARS)
      textParts.push(text)
      continue
    }
    if (block.type !== 'web_search_tool_result') continue
    resultBlockCount += 1
    const resultContent = asArray(block.content, `response.content[${blockIndex}].content`)
    for (const [resultIndex, resultValue] of resultContent.entries()) {
      const result = asRecord(resultValue, `response.content[${blockIndex}].content[${resultIndex}]`)
      if (result.type !== 'web_search_result') continue
      const subject = `response.content[${blockIndex}].content[${resultIndex}]`
      const source = sourceFromRecord(result, subject)
      const snippet = snippets.get(source.url)
      addSource(sources, {
        ...source,
        ...(snippet === undefined || source.snippet !== undefined ? {} : { snippet }),
      })
    }
  }

  if (resultBlockCount === 0) {
    throw new WebError(
      'web search response contained no web_search_tool_result blocks',
      'WEB_PROVIDER_ERROR',
    )
  }
  if (sources.length === 0) {
    throw new WebError(
      'web search response contained no structured search results',
      'WEB_PROVIDER_ERROR',
    )
  }
  const content = textParts.join('\n\n')
  if (content.length > MAX_CONTENT_CHARS) throw responseTooLarge(MAX_RESPONSE_BYTES)
  return {
    sources,
    truncated: false,
    ...(content.length === 0 ? {} : { content }),
  }
}

interface RequestSignals {
  readonly caller?: AbortSignal
  readonly timeout: AbortSignal
  readonly fused: AbortSignal
}

/** The provider registered in `ctx.web` under the desktop-stable id. */
export class WebSearchProvider implements WebSearchProviderContract {
  readonly id = 'dsh-web-search'

  constructor(private readonly resolveOptions: () => WebSearchProviderOptions) {}

  /** Cheap, side-effect-free selection check required by the web seam. */
  available(): boolean {
    try {
      const options = this.resolveOptions()
      return options.enabled
        && (options.protocol === 'openai-responses' || options.protocol === 'anthropic')
        && options.model.trim().length > 0
        && isHttpUrl(options.baseURL)
        && isPositiveInteger(options.timeoutMs)
        && options.timeoutMs <= 60_000
        && isPositiveInteger(options.maxTokens)
        && isPositiveInteger(options.maxUses)
        && (options.apiKey === undefined || options.apiKey.length > 0)
        && (options.apiKeyEnv === undefined || isCredentialRefName(options.apiKeyEnv))
    } catch {
      return false
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    throwIfAborted(signal)
    if (!options.enabled) throw new WebError('dsh-web-search is disabled', 'WEB_PROVIDER_UNAVAILABLE')
    if (!isHttpUrl(options.baseURL)) {
      throw new WebError(
        `web search baseURL must be an absolute http(s) URL, got "${options.baseURL || '(empty)'}"`,
        'WEB_PROVIDER_ERROR',
      )
    }
    if (options.protocol !== 'openai-responses' && options.protocol !== 'anthropic') {
      throw new WebError(`unsupported web search protocol "${String(options.protocol)}"`, 'WEB_PROVIDER_ERROR')
    }
    if (!isPositiveInteger(options.timeoutMs) || options.timeoutMs > 60_000) {
      throw new WebError('web search request timeout must be a positive integer no greater than 60000', 'WEB_PROVIDER_ERROR')
    }
    if (!isPositiveInteger(options.maxTokens) || !isPositiveInteger(options.maxUses)) {
      throw new WebError('web search model limits must be positive integers', 'WEB_PROVIDER_ERROR')
    }
    if (typeof request.query !== 'string' || request.query.trim().length === 0) {
      throw new WebError('web search query must be a non-empty string', 'WEB_PROVIDER_ERROR')
    }
    if (request.query.length > MAX_QUERY_CHARS) {
      throw new WebError(`web search query exceeds the maximum of ${MAX_QUERY_CHARS} characters`, 'WEB_PROVIDER_ERROR')
    }
    if (request.maxResults !== undefined && !isPositiveInteger(request.maxResults)) {
      throw new WebError('web search maxResults must be a positive integer', 'WEB_PROVIDER_ERROR')
    }

    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)
    const query = request.query.trim()
    if (options.protocol === 'anthropic') {
      return this.searchAnthropic(options, apiKey, query, signal)
    }
    return this.searchResponses(options, apiKey, query, signal)
  }

  private async searchResponses(
    options: WebSearchProviderOptions,
    apiKey: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const body = {
      model: options.model,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      ...(options.effort.trim().length === 0 ? {} : { reasoning: { effort: options.effort } }),
      input: buildSearchPrompt(query, options.prompt ?? DEFAULT_PROMPT),
    }
    const payload = await this.requestJson(
      `${options.baseURL.replace(/\/+$/u, '')}/responses`,
      {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'dsh-web-search/0.1.0',
      },
      body,
      options.timeoutMs,
      signal,
    )
    return mapResponsesResponse(payload)
  }

  private async searchAnthropic(
    options: WebSearchProviderOptions,
    apiKey: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const body = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildSearchPrompt(query, options.prompt ?? DEFAULT_PROMPT) }],
      }],
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: options.maxUses,
      }],
    }
    const payload = await this.requestJson(
      `${options.baseURL.replace(/\/+$/u, '')}/messages`,
      {
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': options.apiVersion,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'dsh-web-search/0.1.0',
      },
      body,
      options.timeoutMs,
      signal,
    )
    return mapAnthropicResponse(payload)
  }

  private async apiKey(options: WebSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    if (options.apiKey !== undefined) return usableApiKey(options.apiKey)
    let value: string | undefined
    try {
      value = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw providerError(`web search credential resolution failed: ${String(error)}`, error)
    }
    if (value !== undefined) return usableApiKey(value)
    throw new WebError(
      `web search has no API key for "${options.apiKeyEnv ?? 'DSH_WEB_SEARCH_API_KEY'}"; store it through the credentials service or set apiKeyEnv in the web-search config`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }

  private async requestJson(
    endpoint: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(callerSignal)
    const timeout = AbortSignal.timeout(timeoutMs)
    const fused = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])
    const signals: RequestSignals = { caller: callerSignal, timeout, fused }
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: fused,
      })
    } catch (error) {
      throw this.translateRequestError(error, signals, timeoutMs)
    }

    let text: string
    try {
      text = await this.readResponseText(response, signals)
    } catch (error) {
      throw this.translateRequestError(error, signals, timeoutMs)
    }
    if (!response.ok) {
      throw new WebError(`web search upstream error: ${httpErrorDetail(response.status, text)}`, 'WEB_PROVIDER_ERROR')
    }
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw providerError(`web search returned an unprocessable response body: ${String(error)}`, error)
    }
  }

  private async readResponseText(response: Response, signals: RequestSignals): Promise<string> {
    const declaredLength = response.headers?.get('content-length')
    if (declaredLength !== null && declaredLength !== undefined) {
      const length = Number(declaredLength)
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
        await response.body?.cancel()
        throw responseTooLarge(MAX_RESPONSE_BYTES)
      }
    }

    const body = response.body
    if (body === null || body === undefined || typeof body.getReader !== 'function') {
      if (typeof response.text !== 'function') throw responseShapeError('response body is not readable')
      const text = await abortable(response.text(), signals.fused)
      if (utf8ByteLength(text) > MAX_RESPONSE_BYTES) throw responseTooLarge(MAX_RESPONSE_BYTES)
      return text
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let total = 0
    try {
      for (;;) {
        const next = await abortable(reader.read(), signals.fused)
        if (next.done) break
        const bytes = next.value
        total += bytes.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          throw responseTooLarge(MAX_RESPONSE_BYTES)
        }
        chunks.push(decoder.decode(bytes, { stream: true }))
      }
      chunks.push(decoder.decode())
      return chunks.join('')
    } finally {
      reader.releaseLock()
    }
  }

  private translateRequestError(error: unknown, signals: RequestSignals, timeoutMs: number): WebError {
    // Caller cancellation wins over an internally-created timeout if both
    // signals happen to fire in the same turn.
    if (signals.caller?.aborted === true) return searchAborted(signals.caller, error)
    if (signals.timeout.aborted) {
      return new WebError(`web search request timed out after ${timeoutMs}ms`, 'WEB_PROVIDER_TIMEOUT', { cause: error })
    }
    if (isAbortError(error)) return searchAborted(signals.caller, error)
    if (error instanceof WebError) return error
    return providerError(`web search request failed: ${String(error)}`, error)
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function httpErrorDetail(status: number, text: string): string {
  let detail = `HTTP ${status}`
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return detail
    const record = value as Record<string, unknown>
    const error = record.error
    if (typeof error === 'string' && error.length > 0) return error.slice(0, MAX_SOURCE_FIELD_CHARS)
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.length > 0) return message.slice(0, MAX_SOURCE_FIELD_CHARS)
    }
    const message = record.message
    if (typeof message === 'string' && message.length > 0) return message.slice(0, MAX_SOURCE_FIELD_CHARS)
  } catch {
    // Status is still a useful stable diagnostic when the error body is not JSON.
  }
  return detail
}
