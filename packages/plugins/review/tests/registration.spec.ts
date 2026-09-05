import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { ClientContext } from '../src/client/types.ts'

vi.mock('../src/client/ReviewPage.tsx', () => ({ ReviewPage: () => null }))

it('rolls back page metadata when slot registration fails inside the real Cordis effect', async () => {
  const root = new Context()
  const pages = new Set<string>()
  await root.plugin({ name: 'page-services', apply(ctx: Context) {
    ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key })
    ctx.provide('sessions', {})
    ctx.provide('panelShell', {
      registerPage(meta: { id: string }) {
        pages.add(meta.id)
        return () => { pages.delete(meta.id) }
      },
    })
    void new class extends Service {
      constructor() { super(ctx, 'slots') }
      inject(_name: string, setup: () => Iterable<() => void>) {
        return this.ctx.effect(setup, 'page declaration')
      }
      register(): never { throw new Error('slot registration failed') }
    }()
  } })
  try {
    await expect(root.plugin({
      name: 'review-client', inject,
      apply(ctx: Context) { apply(ctx as unknown as ClientContext) },
    })).rejects.toThrow('slot registration failed')
    expect(pages.size).toBe(0)
  } finally { await root.fiber.dispose() }
})
