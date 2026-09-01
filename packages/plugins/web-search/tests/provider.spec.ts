import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_PROMPT,
  DEFAULT_PROTOCOL,
  LEGACY_DEFAULT_API_KEY_ENV,
  MAX_RESPONSE_BYTES,
  WebSearchProvider,
  isCredentialRefName,
  isHttpUrl,
  mapAnthropicResponse,
  mapResponsesResponse,
  resolveOptions,
  validateConfig,
} from '../src/index.ts'

function options(overrides: Partial<ConstructorParameters<typeof WebSearchProvider>[0] extends () => infer O ? O : never> = {}) {
  return {
    enabled: true,
    protocol: DEFAULT_PROTOCOL,
    baseURL: 'https://search.example/v1',
    model: 'search-model',
    effort: 'low',
    timeoutMs: 5_000,
    apiVersion: '2023-06-01',
    maxTokens: 128,
    maxUses: 3,
    apiKeyEnv: 'SEARCH_API_KEY',
    resolveApiKey: async () => 'sk-test',
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web-search provider validation', () => {
  it('uses the built-in credential slot and hides the legacy reference metadata', async () => {
    expect(DEFAULT_API_KEY_ENV).toBe('DSH_WEB_SEARCH_API_KEY')
    expect(LEGACY_DEFAULT_API_KEY_ENV).toBe('DEEPSEEK_API_KEY')
    expect(Config.dict?.apiKeyEnv?.meta.hidden).toBe(true)
    expect(Config.dict?.apiKeyEnv?.meta.role).toBe('credential-ref')

    const resolve = vi.fn(async (ref: string) => ({ value: `managed:${ref}` }))
    const resolved = resolveOptions({
      get: (key: string) => key === 'credentials' ? { resolve } : undefined,
    } as never, { baseURL: 'https://search.example/v1' })
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(await resolved.resolveApiKey?.()).toBe(`managed:${DEFAULT_API_KEY_ENV}`)
    expect(resolve).toHaveBeenCalledWith(DEFAULT_API_KEY_ENV)
  })

  it('checks the new built-in slot before the legacy slot and does not use the legacy slot when new is set', async () => {
    const resolve = vi.fn(async (ref: string) => ref === DEFAULT_API_KEY_ENV
      ? undefined
      : { value: 'legacy-key' })
    const resolved = resolveOptions({
      get: (key: string) => key === 'credentials' ? { resolve } : undefined,
    } as never, { baseURL: 'https://search.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBe('legacy-key')
    expect(resolve.mock.calls.map(([ref]) => ref)).toEqual([
      DEFAULT_API_KEY_ENV,
      LEGACY_DEFAULT_API_KEY_ENV,
    ])

    resolve.mockClear()
    resolve.mockImplementation(async ref => ({ value: `${ref}-key` }))
    expect(await resolved.resolveApiKey?.()).toBe(`${DEFAULT_API_KEY_ENV}-key`)
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith(DEFAULT_API_KEY_ENV)
  })

  it('treats explicit legacy and custom references as authoritative', async () => {
    const resolve = vi.fn(async (ref: string) => ({ value: `${ref}-key` }))
    const legacy = resolveOptions({
      get: (key: string) => key === 'credentials' ? { resolve } : undefined,
    } as never, { apiKeyEnv: 'SELF_API_KEY', baseURL: 'https://search.example/v1' })
    expect(await legacy.resolveApiKey?.()).toBe('SELF_API_KEY-key')
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('SELF_API_KEY')

    resolve.mockClear()
    const custom = resolveOptions({
      get: (key: string) => key === 'credentials' ? { resolve } : undefined,
    } as never, { apiKeyEnv: 'CUSTOM_SEARCH_KEY', baseURL: 'https://search.example/v1' })
    expect(await custom.resolveApiKey?.()).toBe('CUSTOM_SEARCH_KEY-key')
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith('CUSTOM_SEARCH_KEY')
  })

  it('never bypasses a mounted credentials service with ambient values', async () => {
    const resolve = vi.fn(async () => undefined)
    const environment = { get: vi.fn(() => ({ value: 'ambient-key' })) }
    const resolved = resolveOptions({
      get: (key: string) => key === 'credentials'
        ? { resolve }
        : key === 'launchEnvironment' ? environment : undefined,
    } as never, { baseURL: 'https://search.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBeUndefined()
    expect(environment.get).not.toHaveBeenCalled()
  })

  it('uses only the launch-environment snapshot when the credentials service is absent', async () => {
    const environment = {
      get: vi.fn((name: string) => name === LEGACY_DEFAULT_API_KEY_ENV
        ? { value: 'legacy-ambient-key' }
        : undefined),
    }
    const resolved = resolveOptions({
      get: (key: string) => key === 'launchEnvironment' ? environment : undefined,
    } as never, { baseURL: 'https://search.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBe('legacy-ambient-key')
    expect(environment.get.mock.calls.map(([name]) => name)).toEqual([
      DEFAULT_API_KEY_ENV,
      LEGACY_DEFAULT_API_KEY_ENV,
    ])
  })

  it('accepts only credential-safe http(s) endpoint values', () => {
    expect(isHttpUrl('https://search.example/v1')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isHttpUrl('https://user:pass@example.com')).toBe(false)
    expect(isHttpUrl('/v1')).toBe(false)
    expect(isCredentialRefName('SEARCH_API_KEY')).toBe(true)
    expect(isCredentialRefName('search-api-key')).toBe(false)
  })

  it('rejects invalid settings before a request can run', () => {
    expect(() => validateConfig({ apiKeyEnv: 'not-valid', baseURL: 'https://ok.example' })).toThrow()
    expect(() => validateConfig({ baseURL: 'file:///secret' })).toThrow()
    expect(() => validateConfig({ requestTimeoutMs: 0 })).toThrow()
    expect(() => validateConfig({ anthropicMaxUses: 1.5 })).toThrow()
    expect(new WebSearchProvider(() => options({ apiKeyEnv: 'not-valid' })).available()).toBe(false)
  })

  it('does not expose the product prompt as a configurable provider field', () => {
    const ctx = { get: () => undefined } as never
    const resolved = resolveOptions(ctx, {})
    expect(resolved.prompt).toBe(DEFAULT_PROMPT)
    expect(DEFAULT_PROMPT).toContain('{query}')
  })
})

describe('structured response mapping', () => {
  it('maps Responses citations and action sources and deduplicates metadata', () => {
    const result = mapResponsesResponse({
      output: [
        {
          type: 'web_search_call',
          action: {
            type: 'search',
            sources: [{ type: 'url', url: 'https://source.example/#result' }],
          },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'A cited answer',
            annotations: [{
              type: 'url_citation',
              url: 'https://source.example',
              title: 'Source',
              start_index: 0,
              end_index: 8,
            }],
          }],
        },
      ],
    })
    expect(result.sources).toEqual([{
      url: 'https://source.example/',
      title: 'Source',
      snippet: 'A cited',
    }])
    expect(result.content).toBe('A cited answer')
  })

  it('fails closed when Responses returns prose URLs without structured citations', () => {
    expect(() => mapResponsesResponse({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Try https://hallucinated.example/path' }],
      }],
    })).toThrow(/structured citations/i)
  })

  it('fails closed for malformed output shapes instead of leaking TypeError', () => {
    expect(() => mapResponsesResponse({ output: [null] })).toThrow(/invalid response/i)
    expect(() => mapResponsesResponse({ output: [{ type: 'message', content: null }] })).toThrow(/invalid response/i)
    expect(() => mapAnthropicResponse({ content: [{ type: 'text', text: 'no tool result' }] })).toThrow(/web_search_tool_result/i)
  })

  it('maps Anthropic result blocks and cited excerpts', () => {
    const result = mapAnthropicResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://anthropic.example', title: 'Anthropic', page_age: '2026-01-01' }],
        },
        {
          type: 'text',
          text: 'Summary',
          citations: [{ url: 'https://anthropic.example', cited_text: 'An excerpt' }],
        },
      ],
    })
    expect(result.sources[0]).toEqual({
      url: 'https://anthropic.example',
      title: 'Anthropic',
      snippet: 'An excerpt',
      publishedAt: '2026-01-01',
    })
    expect(result.content).toBe('Summary')
  })
})

describe('network, cancellation and bounded response handling', () => {
  it('sends the fixed Responses request and rejects an oversized body', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://search.example/v1/responses')
      expect(init.redirect).toBe('error')
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: 'search-model',
        input: DEFAULT_PROMPT.replace('{query}', 'news'),
      })
      return new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new WebSearchProvider(() => options()).search({ query: 'news' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('propagates caller cancellation through an in-flight fetch', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = new WebSearchProvider(() => options()).search({ query: 'cancel me' }, controller.signal)
    controller.abort('user cancelled')
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('reports missing credentials with a stable machine code', async () => {
    const provider = new WebSearchProvider(() => options({ resolveApiKey: async () => undefined }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
  })

  it('rejects credentials that cannot be placed in an HTTP header', async () => {
    const provider = new WebSearchProvider(() => options({ resolveApiKey: async () => 'bad\nkey' }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_INVALID',
    })
  })

  it('rejects a successful response with no native source records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ output: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    await expect(new WebSearchProvider(() => options()).search({ query: 'empty' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
})
