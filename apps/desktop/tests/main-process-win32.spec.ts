/**
 * main-process-win32.spec.ts — index.ts 的 win32 分支行为测试：
 * BrowserWindow primary 承载 WebUI（borrowed，非 child view）、自绘菜单
 * 体系 + 原生菜单栏隐藏、Mica/深浅外观控制器装配、appearance IPC、
 * window-all-closed 退出。process.platform 测试内覆写为 'win32'，
 * index.ts 按平台静态分支构造，模块级状态机仍每用例重置。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_FADE_MS, SEAL_TOTAL_MS } from '../src/main/splash'
import {
  attachSupervisor,
  buildHarness,
  elapse,
  FakeSupervisor,
  harnessMocks,
  type Harness,
} from './helpers/electron-harness'

let h: Harness

beforeEach(() => {
  delete process.env.DSH_DESKTOP_CI_SMOKE
  delete process.env.DSH_DESKTOP_CI_SMOKE_STAGE
  vi.useFakeTimers()
  h = buildHarness()
  // win32：BrowserWindow 分支、菜单体系分支、window-all-closed 退出。
  // process.platform 在 Node 下可覆写；getSystemVersion 是 Electron 注入的，
  // 纯 Node 测试进程里不存在，这里补假值（windows-appearance 用它判 Mica）。
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'getSystemVersion', { value: () => '10.0.22631', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
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

/** 完成一次完整 win32 启动（agent ready 于 41234）。 */
async function bootMain(supervisor: FakeSupervisor): Promise<typeof import('../src/main/index')> {
  supervisor.readyWhenStarted(41234, 1111)
  attachSupervisor(h, supervisor)
  const index = await importMain()
  h.electron.app.readyNow()
  await elapse(SEAL_TOTAL_MS + REVEAL_FADE_MS + 200)
  return index
}

describe('win32 启动装配', () => {
  it('主窗口是 BrowserWindow；WebUI 走 primary（borrowed，无 child view）；原生菜单栏隐藏', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const win = h.windows[0]
    expect(win).toBeInstanceOf(h.electron.BrowserWindow)
    expect(win.webContents).not.toBeNull()
    // 自绘菜单体系：application menu 已安装（accelerator 注册）
    expect(h.electron.Menu.buildFromTemplate).toHaveBeenCalled()
    expect(h.electron.Menu.setApplicationMenu).toHaveBeenCalled()
    // 原生菜单栏隐藏（installApplicationMenu 每窗口重设）
    expect(win.style()).toContainEqual({ kind: 'menu-bar-visibility', value: undefined })
    // Mica 外观控制器初始应用（Windows 11 build）
    expect(win.style()).toContainEqual({ kind: 'background-material', value: 'mica' })
    expect(win.style()).toContainEqual({ kind: 'background-color', value: '#00000000' })
    expect(win.style()).toContainEqual({
      kind: 'title-bar-overlay',
      value: { color: '#00000000', height: 44 },
    })

    // 挂载即揭幕：WebUI 在 primary（contents 即窗口 webContents），全程零 child view
    const webui = h.webuiContents()
    expect(webui).toBe(win.webContents)
    expect(webui?.loadUrls).toEqual(['http://127.0.0.1:41234/'])
    expect(win.views).toHaveLength(0) // 无独立 WebUI view
  })

  it('渲染进程关窗：无 mac 拦截，close 即销毁；window-all-closed 后退出', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const win = h.windows[0]

    // win32 无 close-to-hide：close 不被 preventDefault
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    // closed：清理窗口级状态（index 的 closed 处理器）
    win.destroyed = true
    win.emit('closed')
    expect((await import('../src/main/index')).getMainState().hasMainWindow).toBe(false)

    // 全部窗口关闭 → 退出
    h.electron.app.emit('window-all-closed')
    expect(h.electron.app.quit).toHaveBeenCalledTimes(1)
    expect(sup.stop).not.toHaveBeenCalled() // 退出路径经 before-quit 的 stop 编排
  })

  it('appearance IPC：theme-source 仅收可信来源；合法源落到 nativeTheme', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const webui = h.webuiContents()
    const ipc = h.electron.ipcMain

    // 不可信 sender（不是 webuiContents 主 frame）→ 拒绝
    const rogue = { sender: webui, senderFrame: { url: 'http://evil.example/' } }
    await expect(ipc.invoke('dsh-desktop:theme-source', rogue, 'dark')).rejects.toThrow('unauthorized IPC sender')

    // 合法 source 落到 nativeTheme.themeSource
    const frame = { url: 'http://127.0.0.1:41234/' }
    const trusted = { sender: webui, senderFrame: frame }
    ;(webui as { mainFrame?: unknown }).mainFrame = frame
    await expect(ipc.invoke('dsh-desktop:theme-source', trusted, 'dark')).resolves.toBeUndefined()
    expect(h.electron.nativeTheme.themeSource).toBe('dark')

    // 非法 source 拒绝
    await expect(ipc.invoke('dsh-desktop:theme-source', trusted, 'neon')).rejects.toThrow('invalid theme source')

    // appearance-get 返回快照（win32 有外观控制器）
    await expect(ipc.invoke('dsh-desktop:appearance-get', trusted)).resolves.toMatchObject({ backdrop: 'mica', dark: false })
  })

  it('menu-popup：appearance 装配的菜单可弹（win32 专用 IPC）', async () => {
    const sup = new FakeSupervisor()
    await bootMain(sup)
    const webui = h.webuiContents()
    const frame = { url: 'http://127.0.0.1:41234/' }
    ;(webui as { mainFrame?: unknown }).mainFrame = frame
    const trusted = { sender: webui, senderFrame: frame }

    // 菜单已装：popup 返回 true（id/anchor 校验通过）
    const result = await h.electron.ipcMain.invoke(
      'dsh-desktop:menu-popup',
      trusted,
      { id: 'file', anchor: { x: 0, y: 0, width: 100, height: 24 } },
    )
    expect(result).toBe(true)
  })
})