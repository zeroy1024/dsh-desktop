import { describe, expect, it } from 'vitest'
import { CardForm, enumField } from '../src/client/card-form.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '../src/client/types.ts'

interface Settings {
  unknownCapabilityPolicy?: 'passthrough' | 'bridge'
}

function fakeScope(): SettingsScope<Settings> & { snapshot: SettingsScopeSnapshot<Settings> } {
  const scope: SettingsScope<Settings> & { snapshot: SettingsScopeSnapshot<Settings> } = {
    snapshot: {
      status: 'ready' as const,
      value: { unknownCapabilityPolicy: 'passthrough' as const },
      base: { unknownCapabilityPolicy: 'passthrough' as const },
      user: {},
      revision: 1,
      writable: true,
      mode: 'host' as const,
    },
    getSnapshot() { return this.snapshot },
    subscribe() { return () => undefined },
    async set(field: string, value: unknown) {
      this.snapshot = {
        ...this.snapshot,
        value: { ...this.snapshot.value, [field]: value },
        user: { ...(this.snapshot.user as object), [field]: value },
        revision: (this.snapshot.revision ?? 0) + 1,
      }
    },
    async unset(field: string) {
      const user = { ...(this.snapshot.user as Record<string, unknown>) }
      delete user[field]
      this.snapshot = {
        ...this.snapshot,
        user,
        value: { unknownCapabilityPolicy: (this.snapshot.base as Settings).unknownCapabilityPolicy ?? 'passthrough' },
      }
    },
  }
  return scope
}

describe('vision card staged settings', () => {
  it('stages and saves the explicit unknown-capability policy', async () => {
    const scope = fakeScope()
    const form = new CardForm(scope, [
      enumField('unknownCapabilityPolicy', ['passthrough', 'bridge'], 'passthrough'),
    ])
    const actions = form.actions()
    actions.edit('unknownCapabilityPolicy', 'bridge')
    expect(form.shell().dirty).toBe(true)
    await form.save()
    expect(form.shell().failed).toBe(false)
    expect(form.shell().dirty).toBe(false)
    expect(scope.snapshot.user).toEqual({ unknownCapabilityPolicy: 'bridge' })
  })

  it('uses passthrough as the safe display fallback when Host defaults are unavailable', () => {
    const scope = fakeScope()
    scope.snapshot = { ...scope.snapshot, value: undefined, base: undefined }
    const form = new CardForm(scope, [
      enumField('unknownCapabilityPolicy', ['passthrough', 'bridge'], 'passthrough'),
    ])
    expect(form.field('unknownCapabilityPolicy').text).toBe('passthrough')
  })
})
