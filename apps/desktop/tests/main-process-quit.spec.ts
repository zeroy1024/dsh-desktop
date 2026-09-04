/**
 * main-process-quit.spec.ts — index.ts before-quit 退出编排的行为测试：
 * quit 必须等 supervisor.stop() 落定（含 agent 无视 SIGTERM、stop 需升级
 * SIGKILL 才完成的场景），顺序由调用记录断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_FADE_MS, SEAL_TOTAL_MS } from '../src/main/splash'
import {
  attachSupervisor,
  buildHarness,
  elapse,
  flushMicrotasks,
  harnessMocks,
  FakeSupervisor,
  type Harness,
} from './helpers/electron-harness'

let h: Harness

beforeEach(() => {
  delete process.env.DSH_DESKTOP_CI_SMOKE
  delete process.env.DSH_DESKTOP_CI_SMOKE_STAGE
  vi.useFakeTimers()
  h = buildHarness()
})

afterEach(() => {
  h.cleanup()
  vi.useRealTimers()
})

async function importMain(): Promise<typeof import('../src/main/index')> {
  vi.resetModules()
  for (const [path, factory] of harnessMocks(h)) vi.doMock(path, factory)
  const index = await import('../src/main/index')
  index.startMainProcess()
  return index
}

/** 完成一次完整启动（gen1 ready 在 41234/pid 1111）。 */
async function bootMain(supervisor: FakeSupervisor): Promise<typeof import('../src/main/index')> {
  supervisor.readyWhenStarted(41234, 1111)
  attachSupervisor(h, supervisor)
  const index = await importMain()
  h.electron.app.readyNow()
  await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
  return index
}

describe('before-quit 退出编排', () => {
  it('先 preventDefault + 停 agent，stop 落定后 app.quit（顺序断言）', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const order: string[] = []
    const stopGate: { resolve: () => void } = { resolve: () => {} }
    sup.stop.mockImplementation(() => {
      order.push('stop-start')
      return new Promise((resolvePromise) => {
        stopGate.resolve = resolvePromise
      })
    })
    h.electron.app.quit.mockImplementation(() => {
      order.push('quit')
    })
    const event = { preventDefault: vi.fn(() => order.push('preventDefault')) }

    h.electron.app.emit('before-quit', event)
    await flushMicrotasks()

    // stop 挂起期间：quit 绝不先行
    expect(order).toEqual(['preventDefault', 'stop-start'])
    expect(h.electron.app.quit).not.toHaveBeenCalled()
    expect((await import('../src/main/index')).getMainState().allowedPort).toBeNull()

    stopGate.resolve()
    await flushMicrotasks()
    expect(order).toEqual(['preventDefault', 'stop-start', 'quit'])

    // quitRequested 已置位：重复 before-quit 直接短路，stop 不二进
    const again = { preventDefault: vi.fn() }
    h.electron.app.emit('before-quit', again)
    expect(again.preventDefault).not.toHaveBeenCalled()
    expect(sup.stop).toHaveBeenCalledTimes(1)
  })

  it('agent 无视 SIGTERM（stop 升级后迟完成）：quit 跟随 stop 完成时刻，不提前放行', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const order: string[] = []
    sup.stop.mockImplementation(async () => {
      order.push('stop-start')
      // 真实 supervisor 语义：SIGTERM 后 5s 宽限，宽限到期才升级 SIGKILL 并等 close。
      // 这里只在 fake 里复刻「迟完成」这一面（升级逻辑本身在 agent-host 已单测）。
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))
      order.push('stop-escalated')
      sup.emit('exit', null, 'SIGKILL')
      order.push('stop-end')
    })
    h.electron.app.quit.mockImplementation(() => {
      order.push('quit')
    })
    const event = { preventDefault: vi.fn(() => order.push('preventDefault')) }

    h.electron.app.emit('before-quit', event)
    await flushMicrotasks()

    // 宽限期（5s）走了 3s：stop 仍未落定，quit 不放行
    await elapse(3_000)
    expect(order).toEqual(['preventDefault', 'stop-start'])

    // 走完剩余 2s：升级完成 → stop 落定 → quit
    await elapse(2_000)
    expect(order).toEqual(['preventDefault', 'stop-start', 'stop-escalated', 'stop-end', 'quit'])
  })

  it('supervisor 已停止：before-quit 不 preventDefault、不 stop、直接放行', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    sup.state = 'stopped'
    const event = { preventDefault: vi.fn() }

    h.electron.app.emit('before-quit', event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(sup.stop).not.toHaveBeenCalled()
    // 真实 Electron 的 quit 由原生继续（这里只断言主进程不插手）
    expect(h.electron.app.quit).not.toHaveBeenCalled()
    expect((await import('../src/main/index')).getMainState().allowedPort).toBeNull()
  })
})