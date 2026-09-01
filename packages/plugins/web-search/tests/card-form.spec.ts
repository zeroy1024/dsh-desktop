import { describe, expect, it } from 'vitest'
import {
  CardForm,
  numberField,
  textField,
} from '../src/client/card-form.ts'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '../src/client/types.ts'

interface TestSettings {
  endpoint?: string
  timeout?: number
}

function fakeScope(initial: Partial<SettingsScopeSnapshot<TestSettings>> = {}) {
  let snapshot: SettingsScopeSnapshot<TestSettings> = {
    status: 'ready',
    value: { endpoint: 'https://user.example', timeout: 1000 },
    base: { endpoint: 'https://base.example', timeout: 1000 },
    user: { endpoint: 'https://user.example' },
    revision: 0,
    writable: true,
    mode: 'host',
    ...initial,
  }
  const listeners = new Set<() => void>()
  const calls: Array<{ op: 'set' | 'unset'; field: string; value?: unknown }> = []
  const notify = () => { for (const listener of listeners) listener() }
  const scope: SettingsScope<TestSettings> = {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, value) => {
      calls.push({ op: 'set', field, value })
      const user = { ...recordLayer(snapshot.user), [field]: value }
      const next = { ...recordLayer(snapshot.value), [field]: value } as TestSettings
      snapshot = { ...snapshot, value: next, user, revision: (snapshot.revision ?? 0) + 1 }
      notify()
    },
    unset: async (field) => {
      calls.push({ op: 'unset', field })
      const user = { ...recordLayer(snapshot.user) }
      delete user[field]
      const value = { ...recordLayer(snapshot.value) }
      delete value[field]
      const base = snapshot.base as Record<string, unknown> | undefined
      if (base !== undefined && Object.hasOwn(base, field)) value[field] = base[field]
      snapshot = { ...snapshot, value: value as TestSettings, user, revision: (snapshot.revision ?? 0) + 1 }
      notify()
    },
  }
  return { scope, calls }
}

function recordLayer(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

describe('staged settings card form', () => {
  it('does not write while editing and fences reset through unset on save', async () => {
    const { scope, calls } = fakeScope()
    const form = new CardForm(scope, [textField('endpoint'), numberField('timeout')])
    const actions = form.actions()

    actions.edit('endpoint', 'https://draft.example')
    expect(calls).toEqual([])
    expect(form.field('endpoint')).toMatchObject({ text: 'https://draft.example', overridden: true })
    expect(form.shell().dirty).toBe(true)

    await form.save()
    expect(calls).toEqual([{ op: 'set', field: 'endpoint', value: 'https://draft.example' }])
    expect(form.shell().dirty).toBe(false)

    actions.resetField('endpoint')
    expect(calls).toHaveLength(1)
    await form.save()
    expect(calls.at(-1)).toEqual({ op: 'unset', field: 'endpoint' })
    expect(form.field('endpoint').overridden).toBe(false)
  })

  it('blocks invalid numeric drafts and preserves them for correction', async () => {
    const { scope, calls } = fakeScope()
    const form = new CardForm(scope, [numberField('timeout')])
    const actions = form.actions()
    actions.edit('timeout', 'not a number')
    expect(form.shell()).toMatchObject({ dirty: true, invalid: true })
    await form.save()
    expect(calls).toEqual([])
    expect(form.field('timeout')).toMatchObject({ text: 'not a number', invalid: true })
  })

  it('drops staged edits explicitly without touching the settings scope', () => {
    const { scope, calls } = fakeScope()
    const form = new CardForm(scope, [textField('endpoint')])
    const actions = form.actions()
    actions.edit('endpoint', 'https://discarded.example')
    actions.discard()
    expect(calls).toEqual([])
    expect(form.shell().dirty).toBe(false)
    expect(form.field('endpoint').text).toBe('https://user.example')
  })
})
