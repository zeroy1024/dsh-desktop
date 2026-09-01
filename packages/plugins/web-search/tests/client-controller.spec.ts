import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_KEY_REF,
  LEGACY_API_KEY_REF,
  WebSearchCardController,
  type WebSearchSettings,
} from '../src/client/controller.ts'
import type {
  ApiClient,
  SettingsScope,
  SettingsScopeSnapshot,
} from '../src/client/types.ts'

type SnapshotValue = WebSearchSettings & { apiKeyEnv?: unknown }

function fakeScope(
  value: SnapshotValue,
  user: Record<string, unknown> = {},
  base: SnapshotValue = value,
): SettingsScope<WebSearchSettings> {
  const snapshot: SettingsScopeSnapshot<WebSearchSettings> = {
    status: 'ready',
    value: value as WebSearchSettings,
    base,
    user,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async set() {
      for (const listener of listeners) listener()
    },
    async unset() {
      for (const listener of listeners) listener()
    },
  }
}

function credentialApi(configuredRefs: readonly string[] = [], setOk = true) {
  const configured = new Set(configuredRefs)
  const describeCredential = vi.fn(async ({ refs }: { refs: string[] }) => ({
    result: {
      ok: true as const,
      value: {
        credentials: Object.fromEntries(refs.map(ref => [ref, {
          configured: configured.has(ref),
          writable: true,
        }])),
      },
    },
  }))
  const set = vi.fn(async ({ ref }: { ref: string; value: string }) => {
    if (!setOk) return { result: { ok: false as const } }
    configured.add(ref)
    return { result: { ok: true as const, value: {} } }
  })
  const api: ApiClient = { credentials: { describe: describeCredential, set } }
  return { api, describeCredential, set }
}

async function waitForCalls() {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

describe('web-search card credential slot', () => {
  it('uses an explicitly selected SELF_API_KEY slot without exposing it as a field', async () => {
    const { api, describeCredential, set } = credentialApi(['SELF_API_KEY'])
    const controller = new WebSearchCardController(
      fakeScope({ apiKeyEnv: 'SELF_API_KEY' }, { apiKeyEnv: 'SELF_API_KEY' }),
      api,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: ['SELF_API_KEY'] })
    expect(face.hooks.webSearchCard.getSnapshot()).not.toHaveProperty('apiKeyEnv')
    expect(face.hooks.webSearchCard.getSnapshot()).not.toHaveProperty('apiKeyRef')
    expect(face.hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
    expect(() => { face.edit('apiKeyEnv', 'USER_SELECTED_KEY') }).toThrow(
      'web-search settings card has no field apiKeyEnv',
    )

    face.edit('apiKey', 'sk-self')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: 'SELF_API_KEY', value: 'sk-self' }) })
    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ dirty: false, apiKey: { text: '' } })
    })
  })

  it('checks the new slot before the legacy default and writes new keys to the new slot', async () => {
    const { api, describeCredential, set } = credentialApi([LEGACY_API_KEY_REF])
    const controller = new WebSearchCardController(fakeScope({}), api)
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF] })
    expect(face.hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
    face.edit('apiKey', 'sk-default')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: DEFAULT_API_KEY_REF, value: 'sk-default' }) })
    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ dirty: false, apiKey: { text: '' } })
    })
  })

  it('keeps the legacy fallback when the effective setting contains the new default reference', async () => {
    const { api, describeCredential } = credentialApi([LEGACY_API_KEY_REF])
    const controller = new WebSearchCardController(
      fakeScope(
        { apiKeyEnv: DEFAULT_API_KEY_REF },
        { apiKeyEnv: DEFAULT_API_KEY_REF },
      ),
      api,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(controller).toBeDefined()
    expect(describeCredential).toHaveBeenCalledWith({ refs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF] })
    expect(face.hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
  })

  it('lets an explicit user default override a custom base reference', async () => {
    const { api, describeCredential } = credentialApi([LEGACY_API_KEY_REF])
    const controller = new WebSearchCardController(
      fakeScope(
        { apiKeyEnv: DEFAULT_API_KEY_REF },
        { apiKeyEnv: DEFAULT_API_KEY_REF },
        { apiKeyEnv: 'BASE_CUSTOM_SEARCH_KEY' },
      ),
      api,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF] })
    expect(face.hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
  })

  it('uses an explicitly selected custom slot and reports its configured state', async () => {
    const customRef = 'CUSTOM_SEARCH_KEY'
    const { api, describeCredential, set } = credentialApi([customRef])
    const controller = new WebSearchCardController(
      fakeScope({ apiKeyEnv: customRef }, { apiKeyEnv: customRef }),
      api,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [customRef] })
    expect(face.hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
    face.edit('apiKey', 'sk-custom')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: customRef, value: 'sk-custom' }) })
    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ dirty: false, apiKey: { text: '' } })
    })
  })

  it('keeps the staged key when the credentials RPC reports a failed write', async () => {
    const { api, set } = credentialApi(['SELF_API_KEY'], false)
    const controller = new WebSearchCardController(
      fakeScope({ apiKeyEnv: 'SELF_API_KEY' }, { apiKeyEnv: 'SELF_API_KEY' }),
      api,
    )
    const face = controller.inject()
    await waitForCalls()

    face.edit('apiKey', 'sk-rejected')
    face.save()
    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith({ ref: 'SELF_API_KEY', value: 'sk-rejected' })
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({
        dirty: true,
        failed: true,
        apiKey: { text: 'sk-rejected' },
      })
    })
  })

  it('disables the key control when the credentials API is unavailable', async () => {
    const controller = new WebSearchCardController(fakeScope({}), {})
    const face = controller.inject()
    await waitForCalls()

    expect(face.hooks.webSearchCard.getSnapshot().apiKeyWritable).toBe(false)
    expect(controller).toBeDefined()
  })
})
