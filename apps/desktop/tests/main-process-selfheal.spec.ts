/**
 * main-process-selfheal.spec.ts — 打包态 ready 前失败的一次性自愈编排：
 * 首次 start() 拒绝 → 失效/重解压运行时 → 重试一次；第二次失败 → 启动失败
 * 路径（错误框 + quit）。预算整个 app 生命周期一次，restart-agent 不复用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_FADE_MS, SEAL_TOTAL_MS } from '../src/main/splash'
import type { MainStateProbe } from '../src/main/index'
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

// 自愈编排是平台无关逻辑；钉死 darwin 与 main-process.spec.ts 一致——
// 宿主机为 win32 时（Windows CI）真实 win32 分支会调 Electron 注入的
// process.getSystemVersion，纯 Node 测试进程不存在。win32 分支行为由
// main-process-win32.spec.ts 专门覆盖。
const originalPlatform = process.platform

beforeEach(() => {
  delete process.env.DSH_DESKTOP_CI_SMOKE
  delete process.env.DSH_DESKTOP_CI_SMOKE_STAGE
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  h = buildHarness()
  // 自愈路径的 console.warn 带整段 Error stack，测试输出只留断言，不刷屏
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  h.cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function importMain(): Promise<typeof import('../src/main/index')> {
  vi.resetModules()
  for (const [path, factory] of harnessMocks(h)) vi.doMock(path, factory)
  const index = await import('../src/main/index')
  index.startMainProcess()
  return index
}

async function probe(): Promise<MainStateProbe> {
  const index = await import('../src/main/index')
  return index.getMainState()
}

const STARTUP_ERROR = new Error('dsh agent 启动超时（60000ms 内未等到 ready 行）')
const RETRY_READY = { port: 45123, pid: 3333, url: 'http://127.0.0.1:45123/', token: null }

/** 编排一个两次 start 都失败的 supervisor（每次 start 独立 mock 结果）。 */
function supervisorFailingTwice(): FakeSupervisor {
  const sup = new FakeSupervisor()
  sup.start
    .mockRejectedValueOnce(STARTUP_ERROR)
    .mockRejectedValueOnce(STARTUP_ERROR)
  return sup
}

describe('ready 前自愈（打包态）', () => {
  it('首次失败 → 失效+重解压 → 重试成功 → 正常揭幕（预算一次）', async () => {
    h.electron.app.isPackaged = true
    const sup = new FakeSupervisor()
    sup.start
      .mockRejectedValueOnce(STARTUP_ERROR)
      .mockImplementationOnce(async () => {
        sup.state = 'running'
        sup.emit('ready', RETRY_READY)
        return RETRY_READY
      })
    attachSupervisor(h, sup)
    await importMain()
    h.electron.app.readyNow()
    await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)

    expect(sup.start).toHaveBeenCalledTimes(2)
    expect(h.seams.invalidateDshRuntime).toHaveBeenCalledTimes(1)
    expect(h.seams.ensureDshRuntime).toHaveBeenCalledTimes(2) // 首启解压 + 自愈重解压
    expect(h.electron.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(h.electron.app.quit).not.toHaveBeenCalled()
    expect((await probe()).allowedPort).toBe(45123)
    expect((await probe()).runtimeSelfHealUsed).toBe(true)
    expect(h.webuiContents()?.loadUrls).toEqual(['http://127.0.0.1:45123/'])
  })

  it('预算一次性：重试仍失败 → 启动失败路径（错误框 + quit），不第二次重解压', async () => {
    h.electron.app.isPackaged = true
    const sup = supervisorFailingTwice()
    attachSupervisor(h, sup)
    await importMain()
    h.electron.app.readyNow()
    await flushMicrotasks()

    expect(sup.start).toHaveBeenCalledTimes(2)
    expect(h.seams.invalidateDshRuntime).toHaveBeenCalledTimes(1)
    expect(h.seams.ensureDshRuntime).toHaveBeenCalledTimes(2)
    expect(h.electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'dsh agent 启动失败',
      STARTUP_ERROR.message,
    )
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1)
    // 失败后（await start 抛给 reportStartupFailure）端口从未置位
    expect((await probe()).allowedPort).toBeNull()
  })
})

describe('ready 前失败（dev 态与预算已用）', () => {
  it('dev 态原样透传：无自愈动作，直接启动失败路径', async () => {
    h.electron.app.isPackaged = false
    const sup = supervisorFailingTwice()
    attachSupervisor(h, sup)
    await importMain()
    h.electron.app.readyNow()
    await flushMicrotasks()

    // canSelfHealRuntime(false, false) = false：只 start 一次
    expect(sup.start).toHaveBeenCalledTimes(1)
    expect(h.seams.invalidateDshRuntime).not.toHaveBeenCalled()
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1)
    expect(h.electron.dialog.showErrorBox).toHaveBeenCalled()
  })

  it('预算已用后（restart-agent 路径复用同一预算）：再次失败不再重解压', async () => {
    h.electron.app.isPackaged = true
    // gen1 首启失败 → 自愈重试成功：预算在此占用（runtimeSelfHealUsed = true）
    const sup1 = new FakeSupervisor()
    sup1.start
      .mockRejectedValueOnce(STARTUP_ERROR)
      .mockImplementationOnce(async () => {
        sup1.state = 'running'
        sup1.emit('ready', RETRY_READY)
        return RETRY_READY
      })
    attachSupervisor(h, sup1)
    await importMain()
    h.electron.app.readyNow()
    await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
    expect(sup1.start).toHaveBeenCalledTimes(2)
    expect((await probe()).runtimeSelfHealUsed).toBe(true)

    // 重启窗口期新一代失败：预算已用 → 不失效/不重解压，原错误透传上报
    const sup2 = supervisorFailingTwice()
    attachSupervisor(h, sup2)
    const restart = (await import('../src/main/index')).restartAgent()
    await flushMicrotasks()

    expect(sup2.start).toHaveBeenCalledTimes(1) // 无重试
    expect(h.seams.invalidateDshRuntime).toHaveBeenCalledTimes(1) // 只有 gen1 那次
    expect(h.electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'dsh agent 启动失败',
      STARTUP_ERROR.message,
    )
    await expect(restart).rejects.toBe(STARTUP_ERROR) // 错误浮给渲染进程（invoke 侧）
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1) // reportStartupFailure 收尾
    expect((await probe()).allowedPort).toBeNull()
  })
})