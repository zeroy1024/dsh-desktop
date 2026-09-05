import { expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ IconArchiveOutline20: () => null, IconDownloadOutline16: () => null }))
import { apply, downloadSessionLog, type ClientContext } from '../src/client/index.ts'

it('contributes localized export and native archive callbacks, and releases registration', () => {
  const off = vi.fn()
  const factories: Parameters<ClientContext['sessionRowActions']['register']>[0][] = []
  const cleanups: (() => void)[] = []
  apply({
    effect: fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) },
    locale: { register: () => {}, bind: () => key => `localized ${key}` },
    sessionRowActions: { register: factory => { factories.push(factory); return off } },
  })
  const archive = vi.fn()
  const actions = factories[0]!({ sessionId: 'test' as Parameters<typeof factories[0]>[0]['sessionId'], title: 'title', archive })
  expect(actions.map(({ placement, label }) => ({ placement, label }))).toEqual([
    { placement: 'menu', label: 'localized export' }, { placement: 'inline', label: 'localized archive' },
  ])
  actions[1]!.run()
  expect(archive).toHaveBeenCalledOnce()
  for (const cleanup of cleanups.toReversed()) cleanup()
  expect(off).toHaveBeenCalledOnce()
})

it('downloads the selected session and descendants through the native export endpoint', () => {
  const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
  const appendChild = vi.fn()
  vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild } })
  try {
    downloadSessionLog('session & /')
    const url = new URL(anchor.href, 'http://localhost')
    expect(url.pathname).toBe('/api/session.export')
    expect(url.searchParams.get('sessionId')).toBe('session & /')
    expect(url.searchParams.get('includeDescendants')).toBe('true')
    expect(anchor.download).toBe('dsh-session-session____.zip')
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
