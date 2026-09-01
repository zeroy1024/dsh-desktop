import { describe, expect, it, vi } from 'vitest'
import {
  Config,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONFIG,
  LEGACY_DEFAULT_API_KEY_ENV,
  MAX_RESPONSE_BODY_BYTES,
  VisionError,
  describeBytes,
  installBridge,
  installImageInputAdmission,
  installImageInputTransform,
  getModelInfoResolver,
  makeEvidenceCache,
  readLimitedBody,
  resolveOptions,
} from '../src/index.ts'
import type {
  ImageInputAdmissionService,
  ImageInputTransformService,
  VisionOptions,
} from '../src/index.ts'

const options: VisionOptions = {
  enabled: true,
  protocol: 'openai-responses',
  baseURL: 'https://vision.example/v1',
  apiKeyEnv: 'DSH_VISION_API_KEY',
  model: 'grok-4.6',
  prompt: 'describe',
  effort: 'low',
  timeoutMs: 5_000,
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  describeMaxTokens: 1024,
  focusHint: true,
  unknownCapabilityPolicy: 'passthrough',
  cacheSize: 8,
  maxEvidenceChars: 12_000,
  maxImageBytes: 20 * 1024 * 1024,
  resolveApiKey: async () => 'sk-test',
}

describe('vision host safety', () => {
  it('uses the built-in credential reference by default and keeps it out of UI metadata', async () => {
    expect(DEFAULT_API_KEY_ENV).toBe('DSH_VISION_API_KEY')
    expect(DEFAULT_CONFIG.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(Config.dict?.apiKeyEnv?.meta.hidden).toBe(true)
    expect(Config.dict?.apiKeyEnv?.meta.role).toBe('credential-ref')
    expect((DEFAULT_CONFIG as Record<string, unknown>)).not.toHaveProperty('apiKey')

    const resolve = vi.fn(async (ref: string) => ({ value: `managed:${ref}` }))
    const resolved = resolveOptions({
      get: key => key === 'credentials' ? { resolve } : undefined,
    }, {})
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(await resolved.resolveApiKey?.()).toBe(`managed:${DEFAULT_API_KEY_ENV}`)
    expect(resolve).toHaveBeenCalledWith(DEFAULT_API_KEY_ENV)
  })

  it('prefers the new built-in slot and falls back to the old default only when it is unset', async () => {
    const resolve = vi.fn(async (ref: string) => ref === DEFAULT_API_KEY_ENV
      ? undefined
      : { value: 'legacy-key' })
    const resolved = resolveOptions({
      get: key => key === 'credentials' ? { resolve } : undefined,
    }, { baseURL: 'https://vision.example/v1' })
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

  it('treats an explicit custom or legacy reference as authoritative', async () => {
    const resolve = vi.fn(async (ref: string) => ({ value: `${ref}-key` }))
    const resolved = resolveOptions({
      get: key => key === 'credentials' ? { resolve } : undefined,
    }, { apiKeyEnv: LEGACY_DEFAULT_API_KEY_ENV, baseURL: 'https://vision.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBe(`${LEGACY_DEFAULT_API_KEY_ENV}-key`)
    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith(LEGACY_DEFAULT_API_KEY_ENV)
  })

  it('honors an existing explicit legacy reference without migrating or rewriting settings', async () => {
    const resolve = vi.fn(async (ref: string) => ({ value: `managed:${ref}` }))
    const config = { apiKeyEnv: 'SELF_API_KEY' }
    const resolved = resolveOptions({
      get: key => key === 'credentials' ? { resolve } : undefined,
    }, config)
    expect(resolved.apiKeyEnv).toBe('SELF_API_KEY')
    expect(await resolved.resolveApiKey?.()).toBe('managed:SELF_API_KEY')
    expect(resolve).toHaveBeenCalledWith('SELF_API_KEY')
    expect(config).toEqual({ apiKeyEnv: 'SELF_API_KEY' })
  })

  it('uses launch environment only when the credentials service is absent', async () => {
    const environment = {
      get: vi.fn((name: string) => name === DEFAULT_API_KEY_ENV
        ? { value: 'ambient-key' }
        : undefined),
    }
    const resolved = resolveOptions({
      get: key => key === 'launchEnvironment' ? environment : undefined,
    }, { baseURL: 'https://vision.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBe('ambient-key')
    expect(environment.get).toHaveBeenCalledWith(DEFAULT_API_KEY_ENV)
  })

  it('does not bypass a mounted launch-environment snapshot with process.env', async () => {
    vi.stubEnv(DEFAULT_API_KEY_ENV, 'late-process-key')
    const environment = { get: vi.fn((_ref: string) => undefined) }
    const resolved = resolveOptions({
      get: key => key === 'launchEnvironment' ? environment : undefined,
    }, { baseURL: 'https://vision.example/v1' })

    await expect(resolved.resolveApiKey?.()).resolves.toBeUndefined()
    expect(environment.get.mock.calls.map(([ref]) => ref)).toEqual([
      DEFAULT_API_KEY_ENV,
      LEGACY_DEFAULT_API_KEY_ENV,
    ])
    vi.unstubAllEnvs()
  })

  it('uses the old slot only as an ambient fallback and keeps the new slot first', async () => {
    const environment = {
      get: vi.fn((name: string) => name === LEGACY_DEFAULT_API_KEY_ENV
        ? { value: 'legacy-ambient-key' }
        : undefined),
    }
    const resolved = resolveOptions({
      get: key => key === 'launchEnvironment' ? environment : undefined,
    }, { baseURL: 'https://vision.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBe('legacy-ambient-key')
    expect(environment.get.mock.calls.map(([name]) => name)).toEqual([
      DEFAULT_API_KEY_ENV,
      LEGACY_DEFAULT_API_KEY_ENV,
    ])

    environment.get.mockImplementation((name: string) => ({ value: `${name}-key` }))
    expect(await resolved.resolveApiKey?.()).toBe(`${DEFAULT_API_KEY_ENV}-key`)
    expect(environment.get).toHaveBeenCalledTimes(3)
  })

  it('does not bypass a mounted credentials service with an ambient fallback', async () => {
    const environment = {
      get: vi.fn(() => ({ value: 'ambient-key' })),
    }
    const resolve = vi.fn(async () => undefined)
    const resolved = resolveOptions({
      get: key => key === 'credentials'
        ? { resolve }
        : key === 'launchEnvironment' ? environment : undefined,
    }, { baseURL: 'https://vision.example/v1' })
    expect(await resolved.resolveApiKey?.()).toBeUndefined()
    expect(environment.get).not.toHaveBeenCalled()
  })

  it('surfaces credential provider failures instead of silently changing source', async () => {
    const failure = new Error('credential store unavailable')
    const resolve = vi.fn(async () => { throw failure })
    const resolved = resolveOptions({
      get: key => key === 'credentials' ? { resolve } : undefined,
    }, {})
    await expect(resolved.resolveApiKey?.()).rejects.toBe(failure)
  })

  it('accepts legacy target settings without projecting them into routing options', () => {
    const resolved = resolveOptions({
      get: key => key === 'launchEnvironment' ? { get: () => undefined } : undefined,
    }, {
      upstream: 'legacy-provider',
      families: ['legacy-family'],
      models: ['legacy-model'],
    })
    expect(resolved).not.toHaveProperty('targetProvider')
    expect(resolved).not.toHaveProperty('families')
    expect(resolved).not.toHaveProperty('models')
  })

  it('preserves the raw resolver receiver without mutating the runtime', async () => {
    const llm = {
      prefix: 'raw',
      async resolveModelInfo(this: { prefix: string }, provider: string, model: string) {
        return { provider, id: `${this.prefix}:${model}`, inputModalities: ['text'] }
      },
    }
    const ctx = {
      get: (key: string) => key === 'llm' ? llm : undefined,
    }
    const resolveInfo = getModelInfoResolver(ctx)
    expect(resolveInfo).toBeTypeOf('function')
    const original = llm.resolveModelInfo
    const info = await resolveInfo?.('provider-added-later', 'model-with-vl-in-name')
    expect(info?.id).toBe('raw:model-with-vl-in-name')
    expect(info?.inputModalities).toEqual(['text'])
    expect(llm.resolveModelInfo).toBe(original)
    expect(await llm.resolveModelInfo('provider-added-later', 'model-with-vl-in-name')).toEqual({
      provider: 'provider-added-later', id: 'raw:model-with-vl-in-name', inputModalities: ['text'],
    })
  })

  it('does not query capability metadata for a text-only transform request', async () => {
    const resolveInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    let service: ImageInputTransformService | undefined
    installImageInputTransform({
      get: () => undefined,
      provide: (_key, value) => { service = value as ImageInputTransformService },
    }, () => options, makeEvidenceCache(() => 8), resolveInfo)
    await expect(service?.transform({
      provider: 'provider',
      model: 'model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })).resolves.toBeUndefined()
    expect(resolveInfo).not.toHaveBeenCalled()
  })

  it('returns an ephemeral rewritten view for a text-only image request', async () => {
    const resolveInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    const readImage = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      ref: { mediaType: 'image/png' },
    }))
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'detected text' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    const image = { type: 'image' as const, attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }
    const original = [{ role: 'user', content: [{ type: 'text', text: 'read this' }, image] }]
    let service: ImageInputTransformService | undefined
    installImageInputTransform({
      get: keyName => keyName === 'attachments' ? { readImage } : undefined,
      provide: (_key, value) => { service = value as ImageInputTransformService },
    }, () => options, makeEvidenceCache(() => 8), resolveInfo)
    const transformed = await service?.transform({
      provider: 'text-provider',
      model: 'plain-text',
      messages: original,
      inputModalities: ['text'],
    })
    expect(transformed).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'read this' },
        { type: 'text', text: '[图片证据]\ndetected text' },
      ],
    }])
    expect(original[0]?.content?.[1]).toBe(image)
    expect(resolveInfo).not.toHaveBeenCalled()
    expect(readImage).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('abstains for a natively image-capable route and does not call the bridge', async () => {
    const readImage = vi.fn()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const image = { type: 'image' as const, attachment: { attachmentId: 'native-1', mediaType: 'image/png' } }
    let service: ImageInputTransformService | undefined
    installImageInputTransform({
      get: keyName => keyName === 'attachments' ? { readImage } : undefined,
      provide: (_key, value) => { service = value as ImageInputTransformService },
    }, () => options, makeEvidenceCache(() => 8), vi.fn())
    await expect(service?.transform({
      provider: 'native-provider',
      model: 'vision-model',
      messages: [{ role: 'user', content: [image] }],
      inputModalities: ['text', 'image'],
    })).resolves.toBeUndefined()
    expect(readImage).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('registers the first-class transform seam when the LLM runtime provides it', () => {
    let registered: unknown
    const llm = {
      registerInputTransform(this: unknown, transform: unknown) {
        expect(this).toBe(llm)
        registered = transform
        return vi.fn()
      },
    }
    let provided: unknown
    const ctx = {
      get: (keyName: string) => keyName === 'llm' ? llm : undefined,
      provide: (_key: string, value: unknown) => { provided = value },
    }
    expect(installImageInputTransform(ctx, () => options, makeEvidenceCache(() => 8), undefined)).toBe(true)
    expect(provided).toMatchObject({ transform: expect.any(Function) })
    expect(registered).toBe((provided as ImageInputTransformService).transform)
  })

  it('honors caller cancellation before capability lookup or image upload', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const resolveInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    const readImage = vi.fn()
    let service: ImageInputTransformService | undefined
    installImageInputTransform({
      get: keyName => keyName === 'attachments' ? { readImage } : undefined,
      provide: (_key, value) => { service = value as ImageInputTransformService },
    }, () => options, makeEvidenceCache(() => 8), resolveInfo)
    await expect(service?.transform({
      provider: 'text-provider',
      model: 'plain-text',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }],
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'VISION_ABORTED' })
    expect(resolveInfo).not.toHaveBeenCalled()
    expect(readImage).not.toHaveBeenCalled()
  })

  it('passes an image request through when capability is unknown under the default policy', async () => {
    const image = { type: 'image' as const, attachment: { attachmentId: 'unknown-1', mediaType: 'image/png' } }
    let listener: ((request: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
    const delegated = (async function* () { yield 'delegated' })()
    const llm = { stream: vi.fn((_request: Record<string, unknown>) => delegated) }
    installBridge({
      get: keyName => keyName === 'llm'
        ? llm
        : keyName === 'attachments' ? { readImage: vi.fn() } : undefined,
      on: (_name, registered) => { listener = registered as typeof listener },
    }, () => options, makeEvidenceCache(() => 8), async () => undefined)
    const result = listener?.({ provider: 'provider', model: 'model', messages: [{ role: 'user', content: [image] }] }, () => delegated)
    const values: unknown[] = []
    for await (const value of result ?? []) values.push(value)
    expect(values).toEqual(['delegated'])
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('registers capability admission without claiming native image support', () => {
    let service: ImageInputAdmissionService | undefined
    installImageInputAdmission({
      get: () => undefined,
      provide: (_key, value) => { service = value as ImageInputAdmissionService },
    }, () => options)
    expect(service).toBeDefined()
    const resolvedText = { provider: 'p', model: 'm', capability: 'text-only' as const, resolution: 'resolved' as const }
    const unknown = { provider: 'p', model: 'm', capability: 'unknown' as const, resolution: 'resolved' as const }
    const failed = { ...unknown, resolution: 'failed' as const }
    const native = { provider: 'p', model: 'm', capability: 'native' as const, resolution: 'resolved' as const }
    expect(service?.admit(resolvedText)).toBe('bridge')
    expect(service?.admit(unknown)).toBe('abstain')
    expect(service?.admit(failed)).toBe('abstain')
    expect(service?.admit(native)).toBe('abstain')

    let bridgeService: ImageInputAdmissionService | undefined
    installImageInputAdmission({
      get: () => undefined,
      provide: (_key, value) => { bridgeService = value as ImageInputAdmissionService },
    }, () => ({ ...options, unknownCapabilityPolicy: 'bridge' }))
    expect(bridgeService?.admit(unknown)).toBe('bridge')
    expect(bridgeService?.admit(failed)).toBe('abstain')
    expect(bridgeService?.admit(resolvedText)).toBe('bridge')
    expect(bridgeService?.admit(native)).toBe('abstain')

    let unconfigured: ImageInputAdmissionService | undefined
    installImageInputAdmission({
      get: () => undefined,
      provide: (_key, value) => { unconfigured = value as ImageInputAdmissionService },
    }, () => ({ ...options, baseURL: '', unknownCapabilityPolicy: 'bridge' }))
    expect(unconfigured?.admit(resolvedText)).toBe('abstain')
    expect(unconfigured?.admit(unknown)).toBe('abstain')
  })

  it('stops at the response-body bound and reports cancellation distinctly', async () => {
    const tooLarge = new Response('x'.repeat(MAX_RESPONSE_BODY_BYTES + 1), { status: 200 })
    await expect(readLimitedBody(tooLarge, new AbortController().signal, 'test'))
      .rejects.toMatchObject({ code: 'VISION_RESPONSE_TOO_LARGE' })

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(describeBytes(options, new Uint8Array([1, 2, 3]), 'image/png', '', controller.signal))
      .rejects.toMatchObject({ code: 'VISION_ABORTED' })
    expect(new VisionError('x', 'VISION_ABORTED')).toBeInstanceOf(Error)
  })

  it('rejects malformed endpoint before an API key or request is used', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(describeBytes({ ...options, baseURL: 'file:///tmp/image' }, new Uint8Array([1]), 'image/png'))
      .rejects.toMatchObject({ code: 'VISION_INVALID_ENDPOINT' })
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('rejects credentials that cannot be placed in an HTTP header', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(describeBytes(
      { ...options, resolveApiKey: async () => 'bad\nkey' },
      new Uint8Array([1]),
      'image/png',
    )).rejects.toMatchObject({ code: 'VISION_CREDENTIAL_INVALID' })
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('keeps the stream fallback request-scoped and transparent to the session', async () => {
    const image = { type: 'image' as const, attachment: { attachmentId: 'att-1', mediaType: 'image/png' } }
    const messages = [{ role: 'user', content: [image] }]
    let listener: ((request: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
    const delegated = (async function* () { yield 'rewritten' })()
    const llm = { stream: vi.fn((_request: Record<string, unknown>) => delegated) }
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), ref: { mediaType: 'image/png' } }))
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'known' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    installBridge({
      get: keyName => keyName === 'llm' ? llm : keyName === 'attachments' ? { readImage } : undefined,
      on: (_name, registered) => { listener = registered as typeof listener },
    }, () => options, makeEvidenceCache(() => 8), async () => ({ inputModalities: ['text'] }))
    const next = vi.fn(() => delegated)
    const result = listener?.({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages,
    }, next)
    const values: unknown[] = []
    for await (const value of result ?? []) values.push(value)
    expect(values).toEqual(['rewritten'])
    expect(llm.stream).toHaveBeenCalledOnce()
    const request = llm.stream.mock.calls[0]?.[0] as { messages?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
    expect(request.messages?.[0]?.content?.[0]).toEqual({ type: 'text', text: '[图片证据]\nknown' })
    expect(next).not.toHaveBeenCalled()
    expect(messages[0]?.content?.[0]).toBe(image)
    vi.unstubAllGlobals()
  })
})
