import { expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

it('registers its settings when the optional provider activates after the plugin', () => {
  type Scope = { get(key: string): unknown }
  let attach: ((scope: Scope) => void) | undefined
  const context = {
    get: () => undefined,
    inject: (keys: readonly string[], callback: (scope: Scope) => void) => {
      expect(keys).toEqual(['settings'])
      attach = callback
    },
    web: { registerSearchProvider: vi.fn() },
  }
  apply(context as unknown as Parameters<typeof apply>[0])
  expect(attach).toBeTypeOf('function')
  const installSection = vi.fn()
  const scope = { get: () => ({ installSection }) }
  attach!(scope)
  expect(installSection).toHaveBeenCalledWith(context, 'web-search', expect.anything(), expect.anything(), expect.objectContaining({ setSource: expect.any(Function) }))
})
