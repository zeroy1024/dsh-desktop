import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionOpenWorkspacePathRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, expectTypeOf, it, vi } from 'vitest'
import { inject } from '../src/client/dependencies.ts'
import type { FileRemote, FileSession } from '../src/client/session-data.ts'

it('keeps its event observation face compatible with the published Session', () => {
  expectTypeOf<Session>().toExtend<FileSession>()
})

it('can invoke the generated namespace from its declared Cordis scope', async () => {
  const root = new Context()
  const open = vi.fn(async (_request: SessionOpenWorkspacePathRequest) => ({ ok: true }))
  await root.plugin({ name: 'file-services', apply(ctx: Context) {
    void new class extends Service { constructor() { super(ctx, 'remote') } }()
    for (const name of inject) if (name !== 'remote' && name !== 'remote.session') ctx.provide(name, {})
  } })
  const namespace = root.plugin({ name: 'session-namespace', apply(ctx: Context) {
    void new class extends Service {
      constructor() { super(ctx, 'remote.session') }
      openWorkspacePath = open
    }()
  } })
  await namespace
  let remote: FileRemote | undefined
  const teardown = vi.fn()
  await root.plugin({ name: 'file-client', inject: [...inject], apply(ctx: Context) {
    remote = (ctx as unknown as { remote: FileRemote }).remote
    return teardown
  } })
  try {
    expect(remote).toBeDefined()
    await expect(remote!.session.openWorkspacePath({ path: '/workspace/a.ts' })).resolves.toEqual({ ok: true })
    expect(open).toHaveBeenCalledWith({ path: '/workspace/a.ts' })
    await namespace.dispose()
    expect(teardown).toHaveBeenCalledOnce()
  } finally { await root.fiber.dispose() }
})
