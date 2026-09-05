import { afterEach, expect, it, vi } from 'vitest'
import { abortableWait, makeEvidenceCache, resolveOptions, rewriteMessages, VisionError } from '../src/index.ts'

const options = () => ({ ...resolveOptions({ get: () => undefined }, { baseURL: 'https://vision.example/v1', model: 'test' }), resolveApiKey: async () => 'test-key' })
const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }] }]
const image = { data: new Uint8Array([1, 2, 3]), ref: { mediaType: 'image/png' } }
const response = () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'evidence' }] }] }), { headers: { 'content-type': 'application/json' } })
afterEach(() => { vi.unstubAllGlobals() })

it('does not start work for an already cancelled caller', async () => {
  const readImage = vi.fn()
  const controller = new AbortController()
  controller.abort()
  await expect(rewriteMessages(options(), { readImage }, makeEvidenceCache(() => 8), messages, '', controller.signal))
    .rejects.toMatchObject({ code: 'VISION_ABORTED' })
  expect(readImage).not.toHaveBeenCalled()
})

it('observes an already-started rejection even when its waiter was cancelled first', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(abortableWait(Promise.reject(new Error('late failure')), controller.signal))
    .rejects.toMatchObject({ code: 'VISION_ABORTED' })
  // Let Node deliver unhandledRejection; Vitest fails this test run if the
  // abandoned operation has no rejection observer.
  await new Promise<void>(resolve => { setImmediate(resolve) })
})

it('retries the same image after a rejected operation instead of caching cancellation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  const readImage = vi.fn().mockRejectedValueOnce(new VisionError('cancelled', 'VISION_ABORTED')).mockResolvedValue(image)
  const cache = makeEvidenceCache(() => 8)
  await expect(rewriteMessages(options(), { readImage }, cache, messages)).rejects.toMatchObject({ code: 'VISION_ABORTED' })
  expect(cache.size()).toBe(0)
  const result = await rewriteMessages(options(), { readImage }, cache, messages)
  expect(result[0]?.content?.[0]).toEqual({ type: 'text', text: '[图片证据]\nevidence' })
  expect(readImage).toHaveBeenCalledTimes(2)
})

it('keeps a shared operation alive while another caller still needs the image', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  let release!: (value: typeof image) => void
  let sharedSignal: AbortSignal | undefined
  const readImage = vi.fn((_ref: unknown, signal?: AbortSignal) => {
    sharedSignal = signal
    return new Promise<typeof image>(resolve => { release = resolve })
  })
  const cache = makeEvidenceCache(() => 8)
  const controller = new AbortController()
  const first = rewriteMessages(options(), { readImage }, cache, messages, '', controller.signal)
  const second = rewriteMessages(options(), { readImage }, cache, messages)
  controller.abort()
  await expect(first).rejects.toMatchObject({ code: 'VISION_ABORTED' })
  expect(sharedSignal?.aborted).toBe(false)
  release(image)
  expect((await second)[0]?.content?.[0]).toEqual({ type: 'text', text: '[图片证据]\nevidence' })
  expect(readImage).toHaveBeenCalledOnce()
})

it('cancels work after the last waiter leaves and permits an immediate retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  let sharedSignal: AbortSignal | undefined
  const readImage = vi.fn().mockImplementationOnce((_ref: unknown, signal?: AbortSignal) => {
    sharedSignal = signal
    return new Promise(() => {})
  }).mockResolvedValue(image)
  const cache = makeEvidenceCache(() => 8)
  const controller = new AbortController()
  const first = rewriteMessages(options(), { readImage }, cache, messages, '', controller.signal)
  controller.abort()
  await expect(first).rejects.toMatchObject({ code: 'VISION_ABORTED' })
  expect(sharedSignal?.aborted).toBe(true)
  await expect(rewriteMessages(options(), { readImage }, cache, messages)).resolves.toHaveLength(1)
  expect(readImage).toHaveBeenCalledTimes(2)
})
