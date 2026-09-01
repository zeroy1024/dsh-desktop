import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_KEY_REF,
  LEGACY_API_KEY_REF,
  VisionCardController,
  type VisionSettings,
} from '../src/client/vision-card-controller.ts'
import type {
  ConnectionHandle,
  CredentialsApi,
  SettingsScope,
  SettingsScopeSnapshot,
} from '../src/client/types.ts'

type SnapshotValue = VisionSettings & { apiKeyEnv?: unknown }

function fakeScope(value: SnapshotValue, user: Record<string, unknown> = {}): SettingsScope<VisionSettings> {
  const snapshot: SettingsScopeSnapshot<VisionSettings> = {
    status: 'ready',
    value: value as VisionSettings,
    base: value,
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

function credentialConnection(configuredRefs: readonly string[] = [], setOk = true) {
  const configured = new Set(configuredRefs)
  const describeCredential = vi.fn(async ({ refs }: { refs: string[] }) => ({
    result: {
      ok: true,
      value: {
        credentials: Object.fromEntries(refs.map(ref => [ref, {
          configured: configured.has(ref),
          writable: true,
        }])),
      },
    },
  }))
  const set = vi.fn(async ({ ref }: { ref: string; value: string }) => {
    if (!setOk) return { result: { ok: false } }
    configured.add(ref)
    return { result: { ok: true } }
  })
  const credentials: CredentialsApi = { describe: describeCredential, set }
  return {
    connection: { api: { credentials } } satisfies ConnectionHandle,
    describe: describeCredential,
    set,
  }
}

async function waitForCalls() {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

describe('vision card credential slot', () => {
  it('uses an explicitly selected legacy slot for both describe and set without exposing it as a field', async () => {
    const { connection, describe: describeCredential, set } = credentialConnection([LEGACY_API_KEY_REF])
    const controller = new VisionCardController(
      fakeScope({ apiKeyEnv: LEGACY_API_KEY_REF }, { apiKeyEnv: LEGACY_API_KEY_REF }),
      connection,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [LEGACY_API_KEY_REF] })
    expect(face.hooks.visionCard.getSnapshot()).not.toHaveProperty('apiKeyEnv')
    expect(face.hooks.visionCard.getSnapshot().apiKeyConfigured).toBe(true)
    expect(() => { face.edit('apiKeyEnv', 'USER_SELECTED_KEY') }).toThrow(
      'vision settings card has no field apiKeyEnv',
    )

    face.edit('apiKey', 'sk-legacy')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: LEGACY_API_KEY_REF, value: 'sk-legacy' }) })
    await vi.waitFor(() => {
      expect(face.hooks.visionCard.getSnapshot()).toMatchObject({ dirty: false, apiKey: { text: '' } })
    })
  })

  it('checks the new slot before the legacy slot and writes new keys to the new slot', async () => {
    const { connection, describe: describeCredential, set } = credentialConnection([LEGACY_API_KEY_REF])
    const controller = new VisionCardController(
      fakeScope({}),
      connection,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF] })
    expect(face.hooks.visionCard.getSnapshot().apiKeyConfigured).toBe(true)
    face.edit('apiKey', 'sk-default')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: DEFAULT_API_KEY_REF, value: 'sk-default' }) })
    await vi.waitFor(() => {
      expect(face.hooks.visionCard.getSnapshot()).toMatchObject({ dirty: false, apiKey: { text: '' } })
    })
  })

  it('keeps the Host fallback when the built-in default was explicitly persisted', async () => {
    const { connection, describe: describeCredential } = credentialConnection([LEGACY_API_KEY_REF])
    const controller = new VisionCardController(
      fakeScope({ apiKeyEnv: DEFAULT_API_KEY_REF }, { apiKeyEnv: DEFAULT_API_KEY_REF }),
      connection,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF] })
    expect(face.hooks.visionCard.getSnapshot().apiKeyConfigured).toBe(true)
  })

  it('uses an explicitly selected custom slot and reports its configured state', async () => {
    const customRef = 'CUSTOM_VISION_KEY'
    const { connection, describe: describeCredential, set } = credentialConnection([customRef])
    const controller = new VisionCardController(
      fakeScope({ apiKeyEnv: customRef }, { apiKeyEnv: customRef }),
      connection,
    )
    const face = controller.inject()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [customRef] })
    expect(face.hooks.visionCard.getSnapshot().apiKeyConfigured).toBe(true)
    face.edit('apiKey', 'sk-custom')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalledWith({ ref: customRef, value: 'sk-custom' }) })
    await vi.waitFor(() => {
      expect(face.hooks.visionCard.getSnapshot()).toMatchObject({ dirty: false, apiKey: { text: '' } })
    })
  })

  it('keeps a staged key when the credentials RPC reports a failed write', async () => {
    const { connection, set } = credentialConnection([LEGACY_API_KEY_REF], false)
    const controller = new VisionCardController(
      fakeScope({ apiKeyEnv: LEGACY_API_KEY_REF }, { apiKeyEnv: LEGACY_API_KEY_REF }),
      connection,
    )
    const face = controller.inject()
    await waitForCalls()

    face.edit('apiKey', 'sk-rejected')
    face.save()
    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith({ ref: LEGACY_API_KEY_REF, value: 'sk-rejected' })
      expect(face.hooks.visionCard.getSnapshot()).toMatchObject({
        dirty: true,
        failed: true,
        apiKey: { text: 'sk-rejected' },
      })
    })
  })

  it('falls back to the new and legacy slots when an old reference is malformed', async () => {
    const { connection, describe: describeCredential } = credentialConnection()
    const controller = new VisionCardController(
      fakeScope({ apiKeyEnv: 'not a credential reference' }),
      connection,
    )
    expect(controller).toBeDefined()
    await waitForCalls()

    expect(describeCredential).toHaveBeenCalledWith({ refs: [DEFAULT_API_KEY_REF, LEGACY_API_KEY_REF] })
  })
})
