import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject, type ImageInputTransformService, type VisionConfig } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

interface SettingsHooks {
  setSource(source: () => VisionConfig): void
  validate?(value: VisionConfig): void
  onChange(): void
}

interface PendingRequest {
  signal: AbortSignal
  authorization: string | null
  complete(text: string): void
}

/** Real plugin apply and Cordis teardown; only external service methods are doubles. */
async function host() {
  const ctx = new Context()
  contexts.push(ctx)
  let current: VisionConfig = { baseURL: 'https://vision.example/v1', model: 'test', apiKeyEnv: 'OLD_KEY' }
  let settingsHooks: SettingsHooks | undefined
  let transform: ImageInputTransformService['transform'] | undefined
  const transformDisposed = vi.fn()
  const readImage = vi.fn(async () => ({
    data: new Uint8Array([1, 2, 3]), ref: { mediaType: 'image/png' },
  }))
  ctx.provide('attachments', { readImage } as never)
  ctx.provide('credentials', { resolve: async (ref: string) => ({ value: `key-${ref}` }) } as never)
  ctx.provide('llm', {
    registerInputTransform: (callback: ImageInputTransformService['transform']) => {
      transform = callback
      return transformDisposed
    },
  } as never)
  ctx.provide('settings', {
    installSection: (_owner: unknown, _ns: unknown, _schema: unknown, entry: VisionConfig, hooks: SettingsHooks) => {
      current = entry
      settingsHooks = hooks
      hooks.setSource(() => current)
    },
  } as never)
  const requests: PendingRequest[] = []
  const fetchSpy = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal!
    const abort = () => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    requests.push({
      signal,
      authorization: new Headers(init.headers).get('authorization'),
      complete: text => {
        signal.removeEventListener('abort', abort)
        resolve(new Response(JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        }), { headers: { 'content-type': 'application/json' } }))
      },
    })
  }))
  vi.stubGlobal('fetch', fetchSpy)
  const fiber = ctx.plugin({
    name: 'vision-settings-integration', inject: [...inject],
    apply: (scope: Context) => apply(scope as never, current),
  })
  await fiber.await()
  expect(settingsHooks).toBeDefined()
  expect(transform).toBeTypeOf('function')
  return {
    fiber, requests, fetchSpy, readImage, transformDisposed,
    changeCredentials() {
      current = { ...current, apiKeyEnv: 'NEW_KEY' }
      settingsHooks!.validate?.(current)
      settingsHooks!.onChange()
    },
    rewrite() {
      const task = transform!({
        provider: 'text-provider', model: 'text-model', inputModalities: ['text'],
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }] }],
      })
      // Test teardown may abort outstanding work after an earlier assertion fails.
      void task.catch(() => {})
      return task
    },
  }
}

it('separates requests across settings updates and prevents an old result from replacing the new cache', async () => {
  const h = await host()
  const old = h.rewrite()
  await vi.waitFor(() => { expect(h.requests).toHaveLength(1) })
  h.changeCredentials()
  expect(h.requests[0]!.signal.aborted).toBe(false)
  const current = h.rewrite()
  await vi.waitFor(() => { expect(h.requests).toHaveLength(2) })
  expect(h.requests.map(request => request.authorization)).toEqual(['Bearer key-OLD_KEY', 'Bearer key-NEW_KEY'])

  h.requests[1]!.complete('new evidence')
  expect((await current)?.[0]?.content?.[0]).toEqual({ type: 'text', text: '[图片证据]\nnew evidence' })
  // The old caller can still finish using the settings captured at dispatch.
  h.requests[0]!.complete('old evidence')
  expect((await old)?.[0]?.content?.[0]).toEqual({ type: 'text', text: '[图片证据]\nold evidence' })
  expect((await h.rewrite())?.[0]?.content?.[0]).toEqual({ type: 'text', text: '[图片证据]\nnew evidence' })
  expect(h.fetchSpy).toHaveBeenCalledTimes(2)
  expect(h.readImage).toHaveBeenCalledTimes(2)
})

it('cancels both the previous and current settings generations when the plugin unloads', async () => {
  const h = await host()
  const old = h.rewrite()
  await vi.waitFor(() => { expect(h.requests).toHaveLength(1) })
  h.changeCredentials()
  const current = h.rewrite()
  await vi.waitFor(() => { expect(h.requests).toHaveLength(2) })
  expect(h.requests.every(request => !request.signal.aborted)).toBe(true)

  await h.fiber.dispose()
  expect(h.requests.every(request => request.signal.aborted)).toBe(true)
  await expect(old).rejects.toMatchObject({ code: 'VISION_ABORTED' })
  await expect(current).rejects.toMatchObject({ code: 'VISION_ABORTED' })
  expect(h.transformDisposed).toHaveBeenCalledOnce()
})
