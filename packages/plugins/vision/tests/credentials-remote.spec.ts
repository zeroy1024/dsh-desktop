import { expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { inject } from '../src/client/dependencies.ts'
import type { CredentialRemote } from '../src/client/credentials.ts'
import { credentialAdapter } from '../src/client/credentials.ts'

it('uses positional Remote arguments and unwraps RemoteResult for the settings card', async () => {
  const remote = { credentials: {
    describe: vi.fn(async () => ({ ok: true as const, value: { TEST_KEY: { configured: true, writable: true } } })),
    set: vi.fn(async () => ({ ok: true as const, value: undefined })),
  } }
  const api = credentialAdapter(remote)
  expect(await api.describe!({ refs: ['TEST_KEY'] })).toMatchObject({ result: { ok: true, value: { credentials: { TEST_KEY: { configured: true } } } } })
  expect(remote.credentials.describe).toHaveBeenCalledWith(['TEST_KEY'])
  expect(await api.set!({ ref: 'TEST_KEY', value: 'test-value' })).toMatchObject({ result: { ok: true } })
  expect(remote.credentials.set).toHaveBeenCalledWith('TEST_KEY', 'test-value')
})

it('preserves Remote business failures', async () => {
  const api = credentialAdapter({ credentials: {
    describe: async () => ({ ok: false }), set: async () => ({ ok: false }),
  } })
  expect(await api.describe!({ refs: ['TEST_KEY'] })).toEqual({ result: { ok: false } })
  expect(await api.set!({ ref: 'TEST_KEY', value: 'test-value' })).toEqual({ result: { ok: false } })
})


it('declares the real Cordis namespace permission and follows namespace teardown', async () => {
  const root = new Context()
  const describe = vi.fn(async () => ({ ok: true as const, value: { TEST_KEY: { configured: true, writable: true } } }))
  const set = vi.fn(async () => ({ ok: true as const, value: undefined }))
  await root.plugin({ name: 'card-services', apply(ctx: Context) {
    void new class extends Service { constructor() { super(ctx, 'remote') } }()
    for (const name of inject) if (name !== 'remote' && name !== 'remote.credentials') ctx.provide(name, {})
  } })
  const namespace = root.plugin({ name: 'credential-namespace', apply(ctx: Context) {
    void new class extends Service {
      constructor() { super(ctx, 'remote.credentials') }
      describe = describe
      set = set
    }()
  } })
  await namespace
  const teardown = vi.fn()
  let api: ReturnType<typeof credentialAdapter> | undefined
  await root.plugin({ name: 'card-client', inject: [...inject], apply(ctx: Context) {
    api = credentialAdapter((ctx as unknown as { remote: CredentialRemote }).remote)
    return teardown
  } })
  try {
    expect(api).toBeDefined()
    await expect(api!.describe!({ refs: ['TEST_KEY'] })).resolves.toMatchObject({ result: { ok: true } })
    await expect(api!.set!({ ref: 'TEST_KEY', value: 'test-value' })).resolves.toMatchObject({ result: { ok: true } })
    expect(describe).toHaveBeenCalledWith(['TEST_KEY'])
    expect(set).toHaveBeenCalledWith('TEST_KEY', 'test-value')
    await namespace.dispose()
    expect(teardown).toHaveBeenCalledOnce()
  } finally { await root.fiber.dispose() }
})
