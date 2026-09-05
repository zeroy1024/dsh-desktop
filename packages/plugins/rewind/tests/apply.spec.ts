import { describe, expect, it, vi } from 'vitest'
import { RewindUserMessage } from '../src/client/RewindUserMessage.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { ClientContext } from '../src/client/types.ts'

describe('client plugin wiring', () => {
  it('registers dictionaries and shadows the user node renderer', () => {
    const registerLocale = vi.fn(() => () => {})
    const bind = vi.fn(() => (key: string) => `zh:${key}`)
    const registered: Array<{ slot: unknown; options: Record<string, unknown>; component: unknown }> = []
    let currentSlot: unknown
    const context: ClientContext = {
      sessions: { binding: vi.fn() },
      conversation: { createDraftImages: vi.fn(() => []), releaseDraftImages: vi.fn(), input: { for: vi.fn() } },
      sessionEventViews: { register: vi.fn(() => () => {}) },
      effect: factory => factory(),
      inject: (services, callback) => {
        callback({})
      },
      locale: { register: registerLocale, bind },
      slots: {
        inject: (slot, factory) => { currentSlot = slot; return factory() },
        register: (options, component) => {
          registered.push({ slot: currentSlot, options: options as Record<string, unknown>, component })
          return () => {}
        },
      },
    }

    apply(context)
    expect(inject).toEqual(['locale', 'slots', 'sessionEventViews', 'sessions', 'conversation'])
    expect(registerLocale).toHaveBeenCalledWith(
      'rewind',
      expect.objectContaining({ zh: expect.anything(), en: expect.anything() }),
    )

    const user = registered.find(entry => entry.options.key === 'user')
    expect(user?.slot).toBe('conversation.chat.node')
    expect(user?.options).toMatchObject({ name: 'conversation.chat.node', key: 'user', priority: -1, locale: 'rewind' })
    expect(user?.component).toBe(RewindUserMessage)

    // 墓碑不渲染任何标记：不声明子槽、不注册 marker 渲染器。
    expect(registered).toHaveLength(1)
    expect(user?.options.children).toBeUndefined()
  })
})
