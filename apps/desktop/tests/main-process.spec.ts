/**
 * main-process.spec.ts — index.ts 主进程编排的行为测试（端口锁 / 手动重启 /
 * 冷却 / pid 记录 / macOS 关窗语义 / 启动接线）。
 *
 * 用 tests/helpers/electron-harness.ts 的 electron 结构 fake 驱动真实
 * index.ts（经 startMainProcess() 显式接线），每用例 resetModules 重建
 * 模块级状态机；supervisor 在 agent.ts 的 createSupervisor seam 上打桩
 * （评审要求：不重测 agent-host）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentPageUrl } from '@dsh-desktop/bridge'
import type { IpcMainInvokeEvent } from 'electron'
import { readAgentPidRecord } from '../src/main/orphan-reaper'
import { REVEAL_FADE_MS, SEAL_TOTAL_MS } from '../src/main/splash'
import type { MainStateProbe } from '../src/main/index'
import {
  attachSupervisor,
  buildHarness,
  elapse,
  flushMicrotasks,
  harnessMocks,
  makeMountTimeout,
  FakeSupervisor,
  type Harness,
} from './helpers/electron-harness'

let h: Harness
// 本文件的断言以 macOS 语义为准（关窗隐藏、darwin 菜单等）；宿主机平台
// 不影响判定——钉死 darwin，跑完恢复原始值
const originalPlatform = process.platform

beforeEach(() => {
  // ciSmoke 环境变量会改变启动分支（写 marker/自动退出），测试一律清掉
  delete process.env.DSH_DESKTOP_CI_SMOKE
  delete process.env.DSH_DESKTOP_CI_SMOKE_STAGE
  // seal/reveal 延时与 restart 冷却全部走 fake 时钟，确定性可推
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  h = buildHarness()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  h.cleanup()
  vi.useRealTimers()
})

/** 重新挂载 index.ts（模块级状态机归零）并显式接线。 */
async function importMain(): Promise<typeof import('../src/main/index')> {
  vi.resetModules()
  for (const [path, factory] of harnessMocks(h)) vi.doMock(path, factory)
  const index = await import('../src/main/index')
  index.startMainProcess()
  return index
}

/** 读模块状态探针（app 生命周期内同一模块实例）。 */
async function probe(): Promise<MainStateProbe> {
  const index = await import('../src/main/index')
  return index.getMainState()
}

/** 完成一次完整启动：whenReady → bootstrap → seal/reveal。 */
async function bootMain(
  supervisor: FakeSupervisor,
  port = 41234,
  pid = 1111,
): Promise<typeof import('../src/main/index')> {
  supervisor.readyWhenStarted(port, pid)
  attachSupervisor(h, supervisor)
  const index = await importMain()
  h.electron.app.readyNow()
  await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
  return index
}

/** 一个能通过 security.isTrustedIpcSender 的事件（模拟可信渲染进程主 frame）。 */
function trustedFrameEvent(port: number): IpcMainInvokeEvent {
  const frame = { url: agentPageUrl(port) }
  return {
    sender: { mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent
}

describe('端口锁生命周期', () => {
  it('ready 前为 null；ready 置位；restarting/exit/gave-up 清空', async () => {
    const sup = new FakeSupervisor()
    const settle = sup.holdWhenStarted(41234, 1111) // start 挂起：观察就绪前窗口期
    attachSupervisor(h, sup)
    await importMain()
    h.electron.app.readyNow()
    await flushMicrotasks()

    // 就绪前：allowedPort 恒为 null，导航/安全判定一律拒绝
    expect((await probe()).allowedPort).toBeNull()
    const security = await import('../src/main/security')
    expect(security.isTrustedIpcSender(trustedFrameEvent(41234))).toBe(false)

    settle()
    await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
    expect((await probe()).allowedPort).toBe(41234)
    expect(security.isTrustedIpcSender(trustedFrameEvent(41234))).toBe(true)
    expect(security.isTrustedIpcSender(trustedFrameEvent(41235))).toBe(false) // 端口不符

    // 意外退出的重启窗口期（restarting）：端口清空、状态广播
    const webui = h.webuiContents()
    expect(webui).not.toBeNull()
    sup.fireRestarting(1, 500)
    await flushMicrotasks()
    expect((await probe()).allowedPort).toBeNull()
    expect(security.isTrustedIpcSender(trustedFrameEvent(41234))).toBe(false)
    expect(webui?.sends).toContainEqual(['dsh-desktop:agent-status', 'restarting'])

    // 同一代恢复 ready：端口恢复 + 重载到新端口（recovering 路径）
    sup.emit('ready', { port: 41235, pid: 1111, url: agentPageUrl(41235), token: null })
    await flushMicrotasks()
    expect((await probe()).allowedPort).toBe(41235)
    expect(webui?.loadUrls).toEqual([agentPageUrl(41234), agentPageUrl(41235)])
    expect(webui?.sends).toContainEqual(['dsh-desktop:agent-status', 'running'])

    // exit：端口清空
    sup.crash()
    await flushMicrotasks()
    expect((await probe()).allowedPort).toBeNull()

    // gave-up：端口清空 + 错误框 + 退出
    sup.emit('ready', { port: 41236, pid: 1111, url: agentPageUrl(41236), token: null })
    await flushMicrotasks()
    sup.fireGaveUp()
    await flushMicrotasks()
    expect((await probe()).allowedPort).toBeNull()
    expect(h.electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'dsh agent 已停止',
      expect.stringContaining('多次重启失败'),
    )
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1)
  })
})

describe('restart-agent 手动重启', () => {
  it('停旧 agent → 重铺 splash → 新 ready 后才导航新端口（无陈旧页面）', async () => {
    const sup1 = new FakeSupervisor()
    await bootMain(sup1)
    const win = h.windows[0]
    const webui1 = h.webuiContents()
    expect(webui1).not.toBeNull()
    expect(webui1?.loadUrls).toEqual([agentPageUrl(41234)])

    // 新一代 supervisor：start 挂起，观察重启中间态
    const sup2 = new FakeSupervisor()
    const settle2 = sup2.holdWhenStarted(42345, 2222)
    attachSupervisor(h, sup2)
    const invoke = h.electron.ipcMain.invoke(
      'dsh-desktop:restart-agent',
      h.trustedIpcEvent(webui1 as never, 41234),
    )
    await flushMicrotasks()

    // 中间态：旧 webui 已被 dispose 关闭、新 splash 已重铺、旧页面全摘除
    expect(webui1?.destroyed).toBe(true)
    expect(h.views).toHaveLength(3) // splash1, webui1, splash2
    const splash2 = h.views[2]
    expect(splash2.webContents.loadFile).toHaveBeenCalled()
    expect(win.views).toEqual([splash2])
    expect(sup1.stop).toHaveBeenCalledTimes(1)
    // 端口已清；新端口绝未导航（webuiContents 尚无 loadURL）
    expect((await probe()).allowedPort).toBeNull()
    expect(h.webuiContents()).toBeNull()

    // 新 ready 之后才导航（loadURL 只以新端口出现一次）
    settle2()
    await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
    await expect(invoke).resolves.toBeUndefined()

    const webui2 = h.webuiContents()
    expect(webui2).not.toBe(webui1)
    expect(webui2?.loadUrls).toEqual([agentPageUrl(42345)])
    expect(webui1?.loadUrls).toEqual([agentPageUrl(41234)]) // 旧页面从未触碰新端口
    expect((await probe()).allowedPort).toBe(42345)
    expect(sup2.stop).not.toHaveBeenCalled()

    // reveal 完成：webui2 可见、splash2 摘除（重新接线的新一代在 contentView 中）
    const webuiView = h.views[3]
    expect(webuiView.visible).toBe(true)
    expect(win.views).toContain(webuiView)
    expect(win.views).not.toContain(splash2)
  })

  it('冷却窗口内第二次 restart-agent 被拒绝（invoke 拒绝浮给渲染进程）', async () => {
    const sup1 = new FakeSupervisor()
    await bootMain(sup1)
    const sup2 = new FakeSupervisor()
    sup2.readyWhenStarted(42345, 2222)
    attachSupervisor(h, sup2)

    const webui1 = h.webuiContents()
    const first = h.electron.ipcMain.invoke(
      'dsh-desktop:restart-agent',
      h.trustedIpcEvent(webui1 as never, 41234),
    )
    await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
    await expect(first).resolves.toBeUndefined()

    // 距上次接受不足 3s：第二次 invoke 拒绝（决策本身在 restart-throttle 已单测）
    const webui2 = h.webuiContents()
    const second = h.electron.ipcMain.invoke(
      'dsh-desktop:restart-agent',
      h.trustedIpcEvent(webui2 as never, 42345),
    )
    await expect(second).rejects.toThrow('restart-agent 冷却中，请稍后再试')
    expect(sup2.stop).not.toHaveBeenCalled()
  })
})

describe('agent pid 记录文件', () => {
  it('只保留最近一代 ready 的 pid；exit/重启路径清空', async () => {
    const sup1 = new FakeSupervisor()
    await bootMain(sup1) // 41234 / pid 1111
    const pidPath = join(h.electron.app.userDataDir, 'dsh-agent.pid.json')
    expect(readAgentPidRecord(pidPath)).toEqual({ pid: 1111, cliEntry: '/fake/dsh-cli/lib/bin.js' })

    // 手动重启：旧一代 stop → exit 清掉自己的记录；新一代 ready 前文件不存在
    const sup2 = new FakeSupervisor()
    const settle2 = sup2.holdWhenStarted(42345, 2222)
    attachSupervisor(h, sup2)
    const webui1 = h.webuiContents()
    const invoke = h.electron.ipcMain.invoke(
      'dsh-desktop:restart-agent',
      h.trustedIpcEvent(webui1 as never, 41234),
    )
    await flushMicrotasks()
    expect(existsSync(pidPath)).toBe(false)

    // 新一代 ready：记录切换为最新 pid
    settle2()
    await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
    await expect(invoke).resolves.toBeUndefined()
    expect(readAgentPidRecord(pidPath)).toEqual({ pid: 2222, cliEntry: '/fake/dsh-cli/lib/bin.js' })

    // 新一代意外退出：记录清空（下次启动不会误收割）
    sup2.crash()
    expect(existsSync(pidPath)).toBe(false)
  })
})

describe('macOS 窗口关闭语义', () => {
  it('关窗隐藏而非销毁；Cmd-Q（before-quit）后放行真正关闭', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const win = h.windows[0]

    // 第一击：close → preventDefault + hide（渲染进程/SSE 保持存活）
    const first = { preventDefault: vi.fn() }
    win.emit('close', first)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.lifecycle).toContain('hide')

    // Cmd-Q：before-quit 置位 quitRequested 并停 agent
    const quitEvent = { preventDefault: vi.fn() }
    h.electron.app.emit('before-quit', quitEvent)
    await flushMicrotasks()
    expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1)

    // 第二击：不再拦截，真正关闭
    const second = { preventDefault: vi.fn() }
    win.emit('close', second)
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(win.lifecycle.filter((call) => call === 'hide')).toHaveLength(1)
    expect(sup.stop).toHaveBeenCalledTimes(1)
  })

  it('second-instance：唤醒最小化窗口（restore + show + focus）', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const win = h.windows[0]
    win.minimized = true
    h.electron.app.emit('second-instance')
    expect(win.lifecycle).toContain('restore')
    expect(win.lifecycle).toContain('show')
    expect(win.lifecycle).toContain('focus')
    expect(win.minimized).toBe(false)
  })

  it('darwin 下 window-all-closed 不退出', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    h.electron.app.emit('window-all-closed')
    expect(h.electron.app.quit).not.toHaveBeenCalled()
  })
})

describe('启动接线', () => {
  it('单实例锁被占：startMainProcess 直接 quit 且不接生命周期事件', async () => {
    h.electron.app.lockAcquired = false
    const index = await importMain()
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1)
    expect(h.electron.app.listenerCount('before-quit')).toBe(0)
    expect(h.electron.app.listenerCount('second-instance')).toBe(0)
    expect(index.startMainProcess).toBeTypeOf('function')
  })

  it('bootstrap 接线：安全钩子、菜单、收割残留、窗口装配一次完成', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    // 主窗口已创建（BaseWindow，darwin 无 primary）
    expect(h.windows).toHaveLength(1)
    expect(h.windows[0].webContents).toBeNull()
    // 安全钩子已挂（security 走真实模块）
    expect(h.electron.session.defaultSession.setPermissionRequestHandler).toHaveBeenCalled()
    expect(h.electron.shell.openExternal).not.toHaveBeenCalled()
    // darwin 最小原生菜单已安装
    expect(h.electron.Menu.setApplicationMenu).toHaveBeenCalled()
    expect(h.electron.Menu.buildFromTemplate).toHaveBeenCalled()
    // 未就绪时收割残留 agent 是幂等 no-op（无 pid 文件）
    expect((await probe()).hasSupervisor).toBe(true)
  })

  it('activate：已隐藏窗口直接 show；窗口销毁后重建并直挂存活 agent 的 WebUI', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const win = h.windows[0]
    const webui = h.webuiContents()

    // 窗口还在（隐藏态）：activate 只 show，不重建
    h.electron.app.emit('activate')
    expect(h.windows).toHaveLength(1)
    expect(win.lifecycle).toContain('show')
    expect(webui?.loadUrls).toEqual([agentPageUrl(41234)])

    // 窗口销毁后 activate：重建窗口 + 挂存活 agent 的 WebUI（立即导航当前端口）
    win.destroyed = true
    h.electron.app.emit('activate')
    expect(h.windows).toHaveLength(2)
    const win2 = h.windows[1]
    const reattached = h.webuiContents()
    expect(win2.lifecycle).toContain('show')
    expect(reattached?.loadUrls).toEqual([agentPageUrl(41234)]) // 复用存活一代，不重播启动
  })

  it('挂载检测超时：告警后强制揭幕（不卡死在启动层）', async () => {
    const sup = new FakeSupervisor()
    sup.readyWhenStarted(41234, 1111)
    attachSupervisor(h, sup)
    await importMain()
    const webui = new (h.electron.WebContentsView)().webContents
    makeMountTimeout(webui)
    h.electron.app.readyNow()
    // 走完 ready → attachWebui → 挂载检测超时（20s）→ 强制揭幕
    await elapse(SEAL_TOTAL_MS + 20_000 + REVEAL_FADE_MS + 200)
    const win = h.windows[0]
    expect(win.views.length).toBeGreaterThan(0)
    // 强制揭幕路径：webui 视图可见（splash 已摘除）
    expect((await probe()).hasWebui).toBe(true)
    void sup
  })
})