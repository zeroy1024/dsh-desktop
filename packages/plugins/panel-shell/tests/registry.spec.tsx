/**
 * Registry unit behavior: duplicate ids fail loudly, disposers are precise,
 * ordering is the tab-strip contract, badge notifications bump the version,
 * and the reconciliation seat reports pairing failures in both directions.
 * （component spec 未移植：仓库无 jsdom + testing-library 栈，新增依赖
 * 触碰红线；同 activity-group 的取舍，容器交互由实机验证兜底。）
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { PanelShellController, reconcilePageHalves } from '../src/client/registry.ts'

const icon: ReactNode = null

describe('PanelShellController', () => {
  it('registers pages and the disposer removes exactly its own record', () => {
    const registry = new PanelShellController()
    const first = registry.registerPage({ id: 'a', title: () => 'A' })
    const second = registry.registerPage({ id: 'b', title: () => 'B' })

    expect(registry.pages.map(page => page.id)).toEqual(['a', 'b'])

    first()
    expect(registry.pages.map(page => page.id)).toEqual(['b'])
    // A stale disposer (already removed) is a no-op, not a double delete.
    first()
    second()
    expect(registry.pages).toEqual([])
  })

  it('fails loudly on a duplicate page id', () => {
    const registry = new PanelShellController()
    registry.registerPage({ id: 'a', title: () => 'A' })
    expect(() => registry.registerPage({ id: 'a', title: () => 'A2' }))
      .toThrow('panel-shell: page id "a" is already registered')
  })

  it('sorts ordered pages first, absent last, ties by id', () => {
    const registry = new PanelShellController()
    registry.registerPage({ id: 'z', title: () => 'Z' })
    registry.registerPage({ id: 'm', title: () => 'M', order: 2 })
    registry.registerPage({ id: 'a', title: () => 'A', order: 2 })
    registry.registerPage({ id: 'early', title: () => 'E', order: 1 })

    expect(registry.pages.map(page => page.id)).toEqual(['early', 'a', 'm', 'z'])
  })

  it('subscription listeners see a version bump on registration changes and badge notifications', () => {
    const registry = new PanelShellController()
    const listener = vi.fn()
    expect(registry.subscribe(listener)).toBeTypeOf('function')
    const dispose = registry.subscribe(listener)
    const before = registry.getVersion()

    const disposer = registry.registerPage({ id: 'a', title: () => 'A', badge: () => 1 })
    expect(listener).toHaveBeenCalled()
    const afterRegister = registry.getVersion()
    expect(afterRegister).toBeGreaterThan(before)

    registry.notifyBadgeChange('a')
    expect(registry.getVersion()).toBeGreaterThan(afterRegister)

    disposer()
    expect(registry.getVersion()).toBeGreaterThan(afterRegister)
    dispose()
  })

  it('seats and clears the reconciliation error', () => {
    const registry = new PanelShellController()
    expect(registry.reconcileError).toBeNull()
    registry.setReconcileError('panel-shell: broken')
    expect(registry.reconcileError).toBe('panel-shell: broken')
    registry.setReconcileError(null)
    expect(registry.reconcileError).toBeNull()
    // Same-value writes do not bump the version.
    const listener = vi.fn()
    registry.subscribe(listener)
    registry.setReconcileError(null)
    expect(listener).not.toHaveBeenCalled()
  })

  it('exposes page metadata lookups for the container strip', () => {
    const registry = new PanelShellController()
    const onActivate = vi.fn()
    registry.registerPage({ id: 'a', title: () => 'A', icon, badge: () => undefined, onActivate })
    const meta = registry.page('a')
    expect(meta?.title()).toBe('A')
    expect(meta?.badge?.()).toBeUndefined()
    expect(registry.page('missing')).toBeUndefined()
  })
})

describe('reconcilePageHalves', () => {
  it('passes when the two halves pair up exactly', () => {
    const pages = [{ id: 'a', title: () => 'A' }, { id: 'b', title: () => 'B' }]
    expect(reconcilePageHalves(pages, new Set(['a', 'b']))).toBeNull()
  })

  it('reports orphaned metadata (registered without a slot entry)', () => {
    const pages = [{ id: 'a', title: () => 'A' }, { id: 'ghost', title: () => 'G' }]
    const error = reconcilePageHalves(pages, new Set(['a']))
    expect(error).toContain('page metadata without a slot entry: ghost')
    expect(error).toMatch(/^panel-shell:/)
  })

  it('reports orphaned slot entries (slot entry without metadata)', () => {
    const pages = [{ id: 'a', title: () => 'A' }]
    const error = reconcilePageHalves(pages, new Set(['a', 'phantom']))
    expect(error).toContain('slot entries without page metadata: phantom')
  })

  it('reports both directions in one message', () => {
    const error = reconcilePageHalves([{ id: 'meta-only', title: () => 'M' }], new Set(['slot-only']))
    expect(error).toContain('meta-only')
    expect(error).toContain('slot-only')
  })
})
