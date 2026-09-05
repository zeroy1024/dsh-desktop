import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type {
  ClientContext, ModelDirectory, ModelDirectoryState, ModelSelectInjectFace, ModelSelectionScope,
} from '../src/client/types.ts'

const snapshot: ModelDirectoryState = {
  current: { provider: 'provider', model: 'model' },
  routable: true,
  groups: [],
  failures: [],
  status: 'ready',
  error: null,
}

describe('client plugin wiring', () => {
  it('shadows the official seat and injects the official per-session directory', async () => {
    const load = vi.fn().mockResolvedValue({ current: snapshot.current, routable: true, groups: [], failures: [] })
    const select = vi.fn().mockResolvedValue(undefined)
    const directory: ModelDirectory = {
      store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      load,
      select,
    }
    let seatName: string | undefined
    let options: {
      name: string
      priority?: number
      locale?: string
      inject?: (sessionId: string) => ModelSelectInjectFace
    } | undefined
    const register = vi.fn((next: typeof options) => {
      options = next
      return () => {}
    })
    const scope: ModelSelectionScope = {
      slots: {
        inject: (name, factory) => { seatName = name; return factory() },
        register,
      },
      modelDirectories: { directoryFor: vi.fn(() => directory) },
      sessions: { subagentAddress: vi.fn(() => undefined) },
    }
    const localeDisposer = vi.fn()
    const context: ClientContext = {
      effect: (factory) => factory(),
      inject: (services, callback) => {
        expect(services).toEqual(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'])
        return callback(scope)
      },
      locale: { register: vi.fn(() => localeDisposer) },
      slots: scope.slots,
    }

    apply(context)
    expect(inject).toEqual(['locale', 'slots'])
    expect(seatName).toBe('conversation.input.model')
    expect(options).toMatchObject({
      name: 'conversation.input.model',
      priority: -1,
      locale: 'model-selection-direct',
    })

    const face = options?.inject?.('session-1')
    expect(face?.available).toBe(true)
    expect(face?.hooks.modelDirectory).toBe(directory.store)
    face?.load()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    await expect(face?.select({ provider: 'provider', model: 'next', reasoningEffort: 'max' }))
      .resolves.toBe(true)
    expect(select).toHaveBeenCalledWith({ provider: 'provider', model: 'next', reasoningEffort: 'max' })
  })

  it('keeps addressed subagent sessions unavailable without touching model RPCs', async () => {
    const load = vi.fn()
    const select = vi.fn()
    const directory: ModelDirectory = {
      store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      load,
      select,
    }
    let face: ModelSelectInjectFace | undefined
    const scope: ModelSelectionScope = {
      slots: {
        inject: (_name, factory) => factory(),
        register: (options) => {
          face = options.inject?.('child-session')
          return () => {}
        },
      },
      modelDirectories: { directoryFor: () => directory },
      sessions: { subagentAddress: () => ({ parent: 'parent-session' }) },
    }
    const context: ClientContext = {
      effect: factory => factory(),
      inject: (_services, callback) => callback(scope),
      locale: { register: () => () => {} },
      slots: scope.slots,
    }

    apply(context)
    expect(face?.available).toBe(false)
    face?.load()
    await expect(face?.select({ provider: 'provider', model: 'model' })).resolves.toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
})
