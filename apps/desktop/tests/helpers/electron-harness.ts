/**
 * electron-harness.ts — index.ts 行为测试的 electron + 主进程 seam 结构 fake。
 *
 * 设计（与 security-hooks.spec.ts 同样的结构 mock 惯例，无新框架）：
 *   - buildHarness() 每调用一次返回一套全新 fake：每套带独立的
 *     userData 临时目录（真实 fs 落盘，pid 记录可用真实 readAgentPidRecord
 *     读回）、独立的 app/ipcMain/窗口/视图记录与 appReady deferred。
 *   - 测试在 beforeEach 里 vi.doMock 装配 harnessMocks(h)，再
 *     vi.resetModules() + 动态 import index.ts：index.ts 的模块级状态机
 *     （allowedPort/supervisor/mainWindow/restartThrottle/quitRequested/
 *     runtimeSelfHealUsed）每用例重新从零开始，互不串扰。
 *   - 事件语义：FakeApp/FakeWindow 是 EventEmitter，测试 emit
 *     ready/exit/restarting/gave-up/close/closed/second-instance/
 *     activate/before-quit 驱动所有生命周期分支；fake 时钟由 vitest
 *     fake timers 提供（seal/reveal 延时与 restart 冷却确定性可推）。
 *   - electron 之外的 seam 只 stub 三个：agent.ts（createSupervisor，
 *     评审要求不重测 supervisor）、paths.ts（resolveCliEntry 恒定，
 *     避免依赖 vendor 构建产物）、runtime-archive.ts（ensure/invalidate
 *     留痕；canSelfHealRuntime 保持真实纯函数）。splash/security/
 *     orphan-reaper/window-state/application-menu 全部走真实模块。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { canSelfHealRuntime } from '../../src/main/runtime-archive'

// 纯 Node 测试进程没有 Electron 注入的 process.resourcesPath，而 index.ts 打包态
// 分支会 join(process.resourcesPath, 'dsh-cli.tar')。这里补一个假值供打包态用例用。
(process as { resourcesPath?: string }).resourcesPath ??= '/tmp/resources'

/** 可视化 WebContents 的结构 fake：loadURL/send/executeJavaScript 全可断言。 */
export class FakeWebContents extends EventEmitter {
  destroyed = false
  readonly loadUrls: string[] = []
  readonly sends: unknown[][] = []
  executeJavaScriptResult: unknown = true
  loadURL = vi.fn(async (url: string): Promise<void> => {
    this.loadUrls.push(url)
  })
  loadFile = vi.fn(async (): Promise<void> => {})
  executeJavaScript = vi.fn(async (): Promise<unknown> => this.executeJavaScriptResult)
  send = vi.fn((...args: unknown[]): void => {
    this.sends.push(args)
  })
  focus = vi.fn()
  setWindowOpenHandler = vi.fn()
  getZoomFactor = vi.fn((): number => 1)
  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
  }
}

/** WebContentsView 的结构 fake（splash/webui 视图宿主）。 */
export class FakeView {
  readonly webContents = new FakeWebContents()
  bounds: { x: number; y: number; width: number; height: number } | null = null
  visible = true
  background: string | null = null

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }

  setBackgroundColor(color: string): void {
    this.background = color
  }
}

/** BaseWindow 的结构 fake（事件 + 布局 + 外观方法，均留痕）。 */
export class FakeWindow extends EventEmitter {
  destroyed = false
  minimized = false
  maximized = false
  readonly lifecycle: string[] = []
  readonly views: FakeView[] = []
  readonly contentView = {
    children: this.views,
    addChildView: (view: FakeView, index?: number): void => {
      const existing = this.views.indexOf(view)
      if (existing >= 0) this.views.splice(existing, 1)
      if (index !== undefined) this.views.splice(index, 0, view)
      else this.views.push(view)
    },
    removeChildView: (view: FakeView): void => {
      const existing = this.views.indexOf(view)
      if (existing >= 0) this.views.splice(existing, 1)
    },
  }
  size: [number, number] = [1200, 800]
  readonly webContents: FakeWebContents | null
  private readonly styleCalls: Array<{ kind: string; value: unknown }> = []

  constructor(webContents: FakeWebContents | null = null) {
    super()
    this.webContents = webContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  show(): void {
    this.lifecycle.push('show')
  }

  hide(): void {
    this.lifecycle.push('hide')
  }

  focus(): void {
    this.lifecycle.push('focus')
  }

  restore(): void {
    this.minimized = false
    this.lifecycle.push('restore')
  }

  maximize(): void {
    this.maximized = true
    this.lifecycle.push('maximize')
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isMaximized(): boolean {
    return this.maximized
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: this.size[0], height: this.size[1] }
  }

  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: this.size[0], height: this.size[1] }
  }

  getContentSize(): number[] {
    return [...this.size]
  }

  setAutoHideMenuBar(): void {
    this.styleCalls.push({ kind: 'auto-hide-menu-bar', value: undefined })
  }

  setMenuBarVisibility(): void {
    this.styleCalls.push({ kind: 'menu-bar-visibility', value: undefined })
  }

  isMenuBarAutoHide(): boolean {
    return true
  }

  isMenuBarVisible(): boolean {
    return false
  }

  setBackgroundColor(color: string): void {
    this.styleCalls.push({ kind: 'background-color', value: color })
  }

  setBackgroundMaterial(material: string): void {
    this.styleCalls.push({ kind: 'background-material', value: material })
  }

  setTitleBarOverlay(options: unknown): void {
    this.styleCalls.push({ kind: 'title-bar-overlay', value: options })
  }

  style(): Array<{ kind: string; value: unknown }> {
    return [...this.styleCalls]
  }
}

/** BrowserWindow fake：带 primary WebContents。 */
export class FakeBrowserWindow extends FakeWindow {
  constructor() {
    super(new FakeWebContents())
  }
}

/** ipcMain fake：handle 登记 + 可直接触发（带可信 sender 语义）。 */
export class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, handler)
  }

  /**
   * 触发一个已登记的 handler。event 需带 sender（webuiContents 本体）与
   * senderFrame（{ url }），以通过 isTrustedIpcSender 校验。
   */
  async invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`ipcMain 未登记的通道：${channel}`)
    return handler(event, ...args)
  }
}

/** AgentSupervisor 的进程级行为 fake：start/stop 与事件由测试编排。 */
export class FakeSupervisor extends EventEmitter {
  state: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped'
  start = vi.fn<() => Promise<{ port: number; pid: number; url: string; token: string | null }>>()
  stop = vi.fn<() => Promise<void>>(async () => {
    // 真实 supervisor：子进程 close 先 emit('exit')，stop() 的 await 在其后返回
    if (this.state === 'running' || this.state === 'starting') {
      this.state = 'stopped'
      this.emit('exit', 0, null)
    } else {
      this.state = 'stopped'
    }
  })

  /** 编排 start：emit('ready') 后 resolve（与真实 supervisor 同序）。 */
  readyWhenStarted(port: number, pid: number): void {
    this.start.mockImplementation(async () => {
      const info = { port, pid, url: `http://127.0.0.1:${String(port)}/`, token: null }
      this.state = 'running'
      this.emit('ready', info)
      return info
    })
  }

  /** 编排 start：ready 前直接拒绝。 */
  failWhenStarted(error: Error): void {
    this.start.mockImplementation(async () => {
      throw error
    })
  }

  /**
   * 编排 start：挂起直到测试调用返回的 settle（期间可断言中间态）。
   * 返回的 settle 以「emit ready 后 resolve」的真实顺序收尾。
   */
  holdWhenStarted(port: number, pid: number): () => void {
    let settle!: () => void
    this.start.mockImplementation(() => new Promise((resolvePromise) => {
      settle = () => {
        const info = { port, pid, url: `http://127.0.0.1:${String(port)}/`, token: null }
        this.state = 'running'
        this.emit('ready', info)
        resolvePromise(info)
      }
    }))
    return () => settle()
  }

  /** 意外退出（ready 之后崩溃）：emit('exit')。 */
  crash(): void {
    if (this.state === 'running') this.state = 'stopped'
    this.emit('exit', 0, null)
  }

  fireRestarting(attempt: number, retryDelay: number): void {
    this.state = 'starting'
    this.emit('restarting', attempt, retryDelay)
  }

  fireGaveUp(): void {
    this.state = 'stopped'
    this.emit('gave-up', 5)
  }
}

/** app 面 fake：生命周期事件 + 测试可控的 whenReady。 */
export class FakeApp extends EventEmitter {
  isPackaged = false
  readonly version = '0.0.0-test'
  userDataDir = ''
  lockAcquired = true
  quit = vi.fn()
  setName = vi.fn()
  setPath = vi.fn()
  dock = { setIcon: vi.fn() }
  getVersion = vi.fn(() => this.version)
  getPath = vi.fn((name: string) => (name === 'userData' ? this.userDataDir : ''))
  requestSingleInstanceLock = vi.fn(() => this.lockAcquired)
  #whenReadyResolve: (() => void) | null = null
  whenReady = vi.fn(() => new Promise<void>((resolvePromise) => {
    this.#whenReadyResolve = resolvePromise
  }))

  /** 测试驱动：resolve whenReady，触发 bootstrap。 */
  readyNow(): void {
    this.#whenReadyResolve?.()
    this.#whenReadyResolve = null
  }
}

export interface Harness {
  /** electron 各子模块的结构 fake（用户层 vi.doMock('electron') 挂载）。 */
  electron: {
    app: FakeApp
    BaseWindow: typeof FakeWindow
    BrowserWindow: typeof FakeBrowserWindow
    WebContentsView: typeof FakeView
    ipcMain: FakeIpcMain
    dialog: { showErrorBox: ReturnType<typeof vi.fn> }
    nativeImage: { createFromPath: ReturnType<typeof vi.fn> }
    nativeTheme: {
      themeSource: 'system' | 'light' | 'dark'
      shouldUseDarkColors: boolean
      inForcedColorsMode: boolean
      prefersReducedTransparency: boolean
      on: ReturnType<typeof vi.fn>
      off: ReturnType<typeof vi.fn>
    }
    Menu: {
      buildFromTemplate: ReturnType<typeof vi.fn>
      setApplicationMenu: ReturnType<typeof vi.fn>
    }
    screen: {
      getPrimaryDisplay: ReturnType<typeof vi.fn>
      getAllDisplays: ReturnType<typeof vi.fn>
    }
    session: {
      defaultSession: {
        cookies: { get: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
        setPermissionRequestHandler: ReturnType<typeof vi.fn>
        setPermissionCheckHandler: ReturnType<typeof vi.fn>
        webRequest: { onHeadersReceived: ReturnType<typeof vi.fn> }
      }
    }
    shell: { openExternal: ReturnType<typeof vi.fn> }
  }
  /** index.ts 之外的 seam（agent/paths/runtime-archive 的 doMock 面）。 */
  seams: {
    createSupervisor: ReturnType<typeof vi.fn>
    resolveCliEntry: ReturnType<typeof vi.fn>
    ensureDshRuntime: ReturnType<typeof vi.fn>
    invalidateDshRuntime: ReturnType<typeof vi.fn>
  }
  /** 测试期创建的窗口/视图/WebContents（按创建顺序）。 */
  windows: FakeWindow[]
  views: FakeView[]
  contents: FakeWebContents[]
  /** 便捷：最近一个有 loadURL 调用的 WebContents（= 当前 webuiContents）。 */
  webuiContents(): FakeWebContents | null
  /** 便捷：构造过 isTrustedIpcSender 校验的 IPC 事件（sender 必须是 webuiContents）。 */
  trustedIpcEvent(contents: FakeWebContents, port: number): unknown
  /** 清理本套 harness 创建的临时 userData 目录。 */
  cleanup(): void
}

/** 构造一套全新 harness（独立 fake 图 + 独立临时 userData）。 */
export function buildHarness(): Harness {
  const windows: FakeWindow[] = []
  const views: FakeView[] = []
  const contents: FakeWebContents[] = []
  const app = new FakeApp()
  app.userDataDir = mkdtempSync(join(tmpdir(), 'dsh-harness-'))

  class HarnessBaseWindow extends FakeWindow {}
  class HarnessBrowserWindow extends FakeBrowserWindow {
    constructor() {
      super()
      windows.push(this)
      contents.push(this.webContents as FakeWebContents)
    }
  }
  class HarnessView extends FakeView {
    constructor() {
      super()
      views.push(this)
      contents.push(this.webContents)
    }
  }

  const harness: Harness = {
    electron: {
      app,
      BaseWindow: class extends HarnessBaseWindow {
        constructor() {
          super()
          windows.push(this)
        }
      },
      BrowserWindow: HarnessBrowserWindow,
      WebContentsView: HarnessView,
      ipcMain: new FakeIpcMain(),
      dialog: { showErrorBox: vi.fn() },
      nativeImage: { createFromPath: vi.fn(() => ({})) },
      nativeTheme: {
        themeSource: 'system',
        shouldUseDarkColors: false,
        inForcedColorsMode: false,
        prefersReducedTransparency: false,
        on: vi.fn(),
        off: vi.fn(),
      },
      Menu: {
        // items 带 submenu：win32 的 installApplicationMenu 会读 menu.items[i].submenu，
        // popup 弹的是 submenu（真实 Electron 的 submenu 也是 Menu 实例）
        buildFromTemplate: vi.fn((template: Array<Record<string, unknown>>) => ({
          items: template.map(() => ({ submenu: { popup: vi.fn(), closePopup: vi.fn() } })),
          popup: vi.fn(),
          closePopup: vi.fn(),
        })),
        setApplicationMenu: vi.fn(),
      },
      screen: {
        getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
        getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }]),
      },
      session: {
        defaultSession: {
          cookies: { get: vi.fn(async () => []), remove: vi.fn(async () => {}) },
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          webRequest: { onHeadersReceived: vi.fn() },
        },
      },
      shell: { openExternal: vi.fn(async () => undefined) },
    },
    seams: {
      createSupervisor: vi.fn(),
      resolveCliEntry: vi.fn(() => '/fake/dsh-cli/lib/bin.js'),
      ensureDshRuntime: vi.fn(async () => '/fake/runtime'),
      invalidateDshRuntime: vi.fn(async () => {}),
    },
    windows,
    views,
    contents,
    webuiContents(): FakeWebContents | null {
      for (let index = contents.length - 1; index >= 0; index -= 1) {
        const candidate = contents[index]
        // 已销毁的 contents 是旧一代（restart 中 webuiContents 已被置 null）
        if (candidate.loadURL.mock.calls.length > 0 && !candidate.destroyed) return candidate
      }
      return null
    },
    trustedIpcEvent(contentsValue: FakeWebContents, port: number): unknown {
      const frame = { url: `http://127.0.0.1:${String(port)}/` }
      ;(contentsValue as FakeWebContents & { mainFrame?: unknown }).mainFrame = frame
      return { sender: contentsValue, senderFrame: frame }
    },
    cleanup(): void {
      rmSync(app.userDataDir, { recursive: true, force: true })
    },
  }
  return harness
}

/**
 * 需要 vi.doMock 的模块面（electron + 三个主进程 seam）。
 * runtime-archive 的 canSelfHealRuntime 保持真实实现（纯函数）。
 * 返回 `as never` 以适配 vitest 对 doMock 工厂的返回类型约束（测试面。
 * 的 Partial 推断在跨模块对象引用下退化为 never，运行期不受影响）。
 */
export function harnessMocks(h: Harness): Array<[string, () => never]> {
  return [
    ['electron', () => h.electron as never],
    ['../src/main/agent', () => ({ createSupervisor: h.seams.createSupervisor }) as never],
    ['../src/main/paths', () => ({ resolveCliEntry: h.seams.resolveCliEntry }) as never],
    [
      '../src/main/runtime-archive',
      () => ({
        canSelfHealRuntime,
        ensureDshRuntime: h.seams.ensureDshRuntime,
        invalidateDshRuntime: h.seams.invalidateDshRuntime,
      }) as never,
    ],
  ]
}

/** 把测试置入 fake 时钟后，推进指定毫秒并冲刷期间的微任务链。 */
export async function elapse(ms: number): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

/** 冲刷微任务链（不推进时钟）：绕固定轮数，覆盖多段 await 的链路。 */
export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve()
  }
}

/** 便捷：把 createSupervisor seam 编排为返回给定 fake supervisor。 */
export function attachSupervisor(h: Harness, supervisor: FakeSupervisor): void {
  h.seams.createSupervisor.mockReturnValue(supervisor)
}

/** 便捷：把 WebContents 的挂载探测编为恒 false（挂载检测超时强制揭幕路径）。 */
export function makeMountTimeout(contents: FakeWebContents): void {
  contents.executeJavaScriptResult = false
}
