/**
 * Inspect 交接 store 行为：request 覆盖写与同值短路、clear 的 ack 幂等与
 * 空闲静默（不发无谓渲染信号）。与 registry.spec.tsx 的基建取舍差异：
 * panel-store 依赖 runtime 的 createSnapshotStore（测试环境无实体、加载器
 * 才提供），故以内存替身 mock —— 仅实现本包触碰的最小面。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
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

import { createInspectHandoff } from '../src/client/panel-store.ts'

describe('createInspectHandoff', () => {
  it('requests a target for a page and notifies subscribers', () => {
    const handoff = createInspectHandoff()
    expect(handoff.getSnapshot()).toEqual({ pageId: null, callId: null })
    const listener = vi.fn()
    const dispose = handoff.subscribe(listener)

    handoff.request('trajectory', 'call-1')

    expect(handoff.getSnapshot()).toEqual({ pageId: 'trajectory', callId: 'call-1' })
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('short-circuits a repeated request for the same page and callId', () => {
    const handoff = createInspectHandoff()
    const listener = vi.fn()
    handoff.subscribe(listener)
    handoff.request('trajectory', 'call-1')

    handoff.request('trajectory', 'call-1')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('overwrites a pending target with the newer one (latest gesture wins)', () => {
    const handoff = createInspectHandoff()

    handoff.request('trajectory', 'call-1')
    handoff.request('review', 'file-1')

    expect(handoff.getSnapshot()).toEqual({ pageId: 'review', callId: 'file-1' })
  })

  it('clears on ack and goes silent once already idle', () => {
    const handoff = createInspectHandoff()
    const listener = vi.fn()
    const dispose = handoff.subscribe(listener)
    handoff.request('trajectory', 'call-1')
    listener.mockClear()

    handoff.clear()
    expect(handoff.getSnapshot()).toEqual({ pageId: null, callId: null })
    expect(listener).toHaveBeenCalledTimes(1)

    // 空闲再 clear（多页各自身上的 ack 依次到达）不重复发信号。
    handoff.clear()
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('clearFor drops only the closed page’s pending target', () => {
    const handoff = createInspectHandoff()
    handoff.request('trajectory', 'call-1')

    // 别的页关闭不影响 trajectory 的悬挂目标。
    handoff.clearFor('review')
    expect(handoff.getSnapshot()).toEqual({ pageId: 'trajectory', callId: 'call-1' })

    handoff.clearFor('trajectory')
    expect(handoff.getSnapshot()).toEqual({ pageId: null, callId: null })

    // 空闲时 clearFor 静默。
    const listener = vi.fn()
    handoff.subscribe(listener)
    handoff.clearFor('trajectory')
    expect(listener).not.toHaveBeenCalled()
  })
})
