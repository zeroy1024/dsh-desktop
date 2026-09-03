import { describe, expect, it, vi } from 'vitest'
import {
  MAX_RESPONSE_BODY_BYTES,
  buildBody,
  configFingerprint,
  declaresImage,
  evidenceKey,
  isBridgedModel,
  makeEvidenceCache,
  resolveImageCapability,
  stableDigest,
} from '../src/core.ts'
import { rewriteMessages } from '../src/index.ts'
import type { ImageBlock, VisionOptions } from '../src/core.ts'

const options = (overrides: Partial<VisionOptions> = {}): VisionOptions => ({
  enabled: true,
  protocol: 'openai-responses',
  baseURL: 'https://vision.example/v1',
  apiKeyEnv: 'DSH_VISION_API_KEY',
  model: 'grok-4.6',
  prompt: 'describe {focus}',
  effort: 'low',
  timeoutMs: 90_000,
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  describeMaxTokens: 1024,
  focusHint: true,
  unknownCapabilityPolicy: 'passthrough',
  cacheSize: 64,
  maxEvidenceChars: 12_000,
  maxImageBytes: 20 * 1024 * 1024,
  ...overrides,
})

const image: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3 },
}

const textOnlyResolver = async (_provider: string, model: string) => ({
  id: model,
  inputModalities: ['text'],
})

describe('vision capability routing and identity', () => {
  it('routes from declared input modalities regardless of provider/model names', async () => {
    expect(await isBridgedModel(textOnlyResolver, options(), 'provider-that-is-new', 'model-vl')).toBe(true)
    expect(await isBridgedModel(async () => ({ inputModalities: [] }), options(), 'p', 'm')).toBe(true)
    expect(await isBridgedModel(
      async () => ({ inputModalities: ['text', 'image'] }),
      options(),
      'any-provider',
      'plain-text-name',
    )).toBe(false)
    expect(await resolveImageCapability(textOnlyResolver, 'another-provider', 'vision-model')).toBe('unsupported')
    expect(await resolveImageCapability(async () => ({ inputModalities: ['text', 'image'] }), 'p', 'm')).toBe('native')
    expect(await resolveImageCapability(async () => undefined, 'p', 'm')).toBe('unknown')
    expect(declaresImage({ inputModalities: ['text', 'image'] })).toBe(true)
    expect(declaresImage({ inputModalities: ['text'] })).toBe(false)
  })

  it('treats unknown capability as explicit passthrough or bridge policy', async () => {
    expect(await isBridgedModel(async () => undefined, options(), 'provider', 'model')).toBe(false)
    expect(await isBridgedModel(async () => ({ inputModalities: undefined }), options(), 'provider', 'model')).toBe(false)
    const metadataError = new Error('metadata unavailable')
    await expect(isBridgedModel(async () => { throw metadataError }, options(), 'provider', 'model'))
      .rejects.toBe(metadataError)

    const bridge = options({ unknownCapabilityPolicy: 'bridge' })
    expect(await isBridgedModel(undefined, bridge, 'provider', 'model')).toBe(true)
    expect(await isBridgedModel(async () => undefined, bridge, 'provider', 'model')).toBe(true)
    await expect(isBridgedModel(async () => { throw new Error('metadata unavailable') }, bridge, 'provider', 'model'))
      .rejects.toThrow('metadata unavailable')
  })

  it('honors cancellation while waiting for capability metadata', async () => {
    const controller = new AbortController()
    let release!: () => void
    const pending = new Promise<undefined>(resolve => { release = () => { resolve(undefined) } })
    const request = isBridgedModel(async () => pending, options(), 'provider', 'model', controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(request).rejects.toMatchObject({ code: 'VISION_ABORTED' })
    release()

    const adapterAbort = Object.assign(new Error('adapter cancelled'), { name: 'AbortError' })
    await expect(isBridgedModel(
      async () => { throw adapterAbort },
      options({ unknownCapabilityPolicy: 'bridge' }),
      'provider',
      'model',
    )).rejects.toMatchObject({ code: 'VISION_ABORTED' })
  })

  it('includes image and config identity so evidence is never cross-reused', () => {
    const first = evidenceKey(image, options())
    expect(first).not.toBe(evidenceKey(image, options({ model: 'other-vision' })))
    expect(first).not.toBe(evidenceKey(image, options({ focusHint: false })))
    expect(first).not.toBe(evidenceKey(image, options({ maxImageBytes: 1024 })))
    expect(first).not.toBe(evidenceKey({ ...image, attachment: { attachmentId: 'sha256:other' } }, options()))
    expect(configFingerprint(options())).toBe(configFingerprint(options()))
    expect(stableDigest('a')).not.toBe(stableDigest('b'))
  })
})

describe('evidence cache', () => {
  it('is LRU and respects the live configured size', async () => {
    let limit = 2
    const cache = makeEvidenceCache(() => limit)
    const one = Promise.resolve({ ok: true, text: 'one' })
    const two = Promise.resolve({ ok: true, text: 'two' })
    const three = Promise.resolve({ ok: true, text: 'three' })
    cache.set('1', one)
    cache.set('2', two)
    expect(await cache.get('1')).toEqual({ ok: true, text: 'one' })
    cache.set('3', three)
    expect(cache.peek('2')).toBeUndefined()
    expect(cache.peek('1')).toBe(one)
    limit = 1
    cache.set('4', Promise.resolve({ ok: true, text: 'four' }))
    expect(cache.size()).toBe(1)
  })

  it('keeps focus out of the cache key so history images are not re-transcribed', async () => {
    const readImage = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      ref: { mediaType: 'image/png' },
    }))
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'detected text' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    const cache = makeEvidenceCache(() => 8)
    const opts = options({ resolveApiKey: async () => 'sk-test' })
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }, image] }]
    const first = await rewriteMessages(opts, { readImage }, cache, messages, 'chart')
    expect(fetchSpy).toHaveBeenCalledOnce()
    // 同一图片、不同 focus：缓存必须命中，第二轮零新增视觉请求。
    const second = await rewriteMessages(opts, { readImage }, cache, messages, 'table')
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(readImage).toHaveBeenCalledOnce()
    expect(second).toEqual(first)
    expect(second[0]?.content?.[1]).toEqual({ type: 'text', text: '[图片证据]\ndetected text' })
    vi.unstubAllGlobals()
  })
})

describe('wire helpers', () => {
  it('keeps the three image request shapes provider-specific', () => {
    const response = buildBody(options(), 'look', 'image/png', 'QUJD')
    expect(response.input).toBeDefined()
    expect((response.input as Array<{ content: Array<{ type: string }> }>)[0]?.content[1]?.type).toBe('input_image')
    const chat = buildBody(options({ protocol: 'openai-chat' }), 'look', 'image/png', 'QUJD')
    expect((chat.messages as Array<{ content: Array<{ type: string }> }>)[0]?.content[1]?.type).toBe('image_url')
    const anthropic = buildBody(options({ protocol: 'anthropic' }), 'look', 'image/png', 'QUJD')
    expect((anthropic.messages as Array<{ content: Array<{ type: string }> }>)[0]?.content[1]?.type).toBe('image')
  })

  it('keeps the response body bound suitable for image evidence', () => {
    expect(MAX_RESPONSE_BODY_BYTES).toBeGreaterThan(1024 * 1024)
  })
})
