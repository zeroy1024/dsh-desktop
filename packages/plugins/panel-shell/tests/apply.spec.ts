import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T,>(init: T) => {
    let state = init
    const listeners = new Set<() => void>()
    const emit = (): void => { for (const fn of listeners) fn() }
    return {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      update: (mutator: (draft: T) => void) => {
        const draft = structuredClone(state)
        mutator(draft)
        state = draft
        emit()
      },
      set: (next: T) => { state = next; emit() },
    }
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ IconDataOutline16: () => null }))
vi.mock('../src/client/horizontal-tab-scroll.ts', () => ({ useHorizontalTabScroll: () => undefined }))
vi.mock('../src/client/PanelShell.tsx', () => ({ PanelShell: () => null }))
import { apply, inject } from '../src/client/index.ts'
import type { ClientContext } from '../src/client/types.ts'

it('boots without trajectory and attaches it only after the child slot declaration', () => {
  const declared = new Set(['panel'])
  const slotEntries = new Map<string, { options: { id?: string } }[]>()
  let provideName = ''
  let optional: Parameters<ClientContext['inject']>[1] | undefined
  const cleanups: (() => void)[] = []
  const context: ClientContext = {
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off) },
    inject: (_keys, fn) => { optional = fn },
    get: () => undefined,
    reflect: { provide: (name) => { provideName = name; return () => {} } },
    locale: { register: () => {}, bind: () => key => key },
    layout: { openPanel: () => {} },
    slots: {
      inject: (name, fn) => { expect(declared.has(name)).toBe(true); const off = fn(); if (typeof off === 'function') cleanups.push(off as () => void); return off },
      register: (options) => {
        for (const name of Object.keys(options.children ?? {})) declared.add(name)
        slotEntries.set(options.name, [{ options }])
        return () => {}
      },
      entries: name => slotEntries.get(name) ?? [],
      subscribe: () => () => {},
    },
  }
  expect(inject).not.toContain('trajectoryView')
  apply(context)
  expect(provideName).toBe('panelShell')
  const setDefaultEnabled = vi.fn()
  optional!({ ...context, trajectoryView: {
    create: () => ({ component: () => createElement('div'), options: {
      id: 'trajectory', order: 10, locale: 'trajectory', label: () => 'Trajectory',
      children: { 'conversation.trajectory.images': { kind: 'single', scope: 'session' } },
      inject: () => ({
        hooks: { duration: createSnapshotStore(false) },
        loadOlder: async () => false,
        loadImage: Object.assign(async () => '', { peek: () => undefined }),
        setActualDuration: () => {},
      }),
    } }),
    setDefaultEnabled,
  } })
  expect(setDefaultEnabled).toHaveBeenCalledWith(false)
  expect(slotEntries.get('panel-shell.page')?.[0]?.options.id).toBe('trajectory')
  for (const off of cleanups.toReversed()) off()
  expect(setDefaultEnabled).toHaveBeenLastCalledWith(true)
})
