/**
 * index.ts — Electron 主进程入口。
 *
 * 启动顺序：单实例锁 → 安全钩子 → 收割上一代残留 agent（pid 文件核身）
 * → 建隐藏主窗口（Windows 为 BrowserWindow，macOS/Linux 为 BaseWindow）
 * → splash → 起 dsh agent → 渲染进程 loadURL(http://127.0.0.1:<port>/)
 * → 挂载检测 → 定格 → 揭幕。
 *
 * Windows 的 BrowserWindow primary webContents 直接承载 WebUI，启动层作为
 * contentView 顶层的独立 WebContentsView 覆盖其上；macOS/Linux 继续由
 * splash 控制器创建并管理独立的 WebUI child view。
 */
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  type WebContents,
} from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPageUrl } from '@dsh-desktop/bridge'
import { createSupervisor } from './agent'
import {
  isApplicationMenuId,
  isValidPopupAnchor,
  installApplicationMenu,
  applicationMenuState,
  popupApplicationMenu,
} from './application-menu'
import { defaultReapDeps, reapOrphanedAgent, removeAgentPidRecord, writeAgentPidRecord } from './orphan-reaper'
import { resolveCliEntry } from './paths'
import { ensureDshRuntime } from './runtime-archive'
import { installSecurityHooks, isTrustedIpcSender } from './security'
import {
  MOUNT_TIMEOUT_MS,
  SEAL_TOTAL_MS,
  createSplashController,
  createWebuiWebPreferences,
  type SplashController,
} from './splash'
import {
  createWindowsAppearanceController,
  isNativeThemeSource,
  type WindowsAppearanceController,
  type WindowsAppearanceSnapshot,
} from './windows-appearance'
import { loadWindowState, trackWindowState } from './window-state'
import type { AgentReadyInfo, AgentSupervisor } from '@dsh-desktop/agent-host'

let supervisor: AgentSupervisor | null = null
let mainWindow: BaseWindow | null = null
let primaryWebContents: WebContents | null = null
let splash: SplashController | null = null
let webuiContents: WebContents | null = null
/** Windows 外观控制器（Mica/solid、深浅、forced colors、减少透明度）。 */
let windowsAppearance: WindowsAppearanceController | null = null
/** 当前这一代 agent 的监听端口；未 ready 时为 null，导航与 IPC 一律拒绝。 */
let allowedPort: number | null = null
let quitRequested = false
let startupTask: Promise<void> | null = null
let restartTask: Promise<void> | null = null
let startupGeneration = 0
const ciSmoke = process.env.DSH_DESKTOP_CI_SMOKE === '1'
const ciSmokeReadyMarker = '.dsh-desktop-ci-ready.json'

// dev 态 macOS 菜单栏应用名取的是 Electron 二进制的 CFBundleName，productName
// 管不到它，必须显式 setName（值与 productName 一致，userData 路径不变）
app.setName('DeepSeek Harness')
// CI 必须完全隔离开发机/runner 的 Electron profile；真实 dsh 数据仍由同一个
// 临时 DSH_HOME 隔离。生产启动不读取这条测试专用分支。
if (ciSmoke && process.env.DSH_HOME !== undefined) {
  app.setPath('userData', join(process.env.DSH_HOME, 'electron-user-data'))
}

/**
 * 应用图标（resources/icons/，dist 的上一级）。
 * Windows 任务栏对窗口图标 1:1 渲染且没有 macOS 的 grid 边距补偿，
 * icon.png 四周 10% 透明边距会让图标视觉上偏小，因此用铺满画布的
 * icon-win.png 变体；其余平台保持原图标。
 */
function appIconPath(): string {
  const name = process.platform === 'win32' ? 'icon-win.png' : 'icon.png'
  return join(import.meta.dirname, '..', 'resources', 'icons', name)
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 渲染进程探测脚本：返回桌面标记与真实几何。Windows 额外采集 WCO 状态：
 * navigator.windowControlsOverlay 只有 BrowserWindow primary 能拿到非零
 * rect（0.0.3/0.0.4 的 BaseWindow+WebContentsView 永远为 0——正是两次叠键
 * 回归的根因），因此这里断言的是「真实 rect 非零 + 页面元素不与 caption
 * 区相交」，而不是任何固定像素。 */
const rendererProbe = `(() => {
  const cluster = document.querySelector('[data-dsh-panel-cluster]')
  const titleband = document.querySelector('[data-dsh-titleband]')
  const menubar = document.querySelector('[data-dsh-menubar]')
  const inset = cluster === null
    ? -1
    : Math.round(window.innerWidth - cluster.getBoundingClientRect().right)
  const wco = window.navigator.windowControlsOverlay
  const wcoVisible = wco !== undefined && wco.visible === true
  let wcoRect = null
  let wcoLeftInset = -1
  let wcoRightInset = -1
  if (wcoVisible) {
    try {
      const rect = wco.getTitlebarAreaRect()
      wcoRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      wcoLeftInset = Math.round(rect.x)
      wcoRightInset = Math.round(window.innerWidth - (rect.x + rect.width))
    } catch {
      // 理论上 visible=true 时必然可取；取不到按未就绪处理，下轮再试
    }
  }
  const clusterRight = cluster === null ? -1 : Math.round(cluster.getBoundingClientRect().right)
  return {
    desktop: document.documentElement.hasAttribute('data-dsh-desktop'),
    platform: document.documentElement.dataset.dshPlatform,
    bridgePlatform: window.dshDesktop?.platform,
    titleband: titleband !== null,
    panelCluster: cluster !== null,
    clusterInset: inset,
    menubar: menubar !== null,
    wcoVisible,
    wcoRect,
    wcoLeftInset,
    wcoRightInset,
    clusterRight,
    viewportWidth: Math.round(window.innerWidth),
    appearanceBackdrop: document.documentElement.dataset.dshBackdrop ?? null,
  }
})()`

interface CiSmokeProbe {
  desktop?: unknown
  platform?: unknown
  bridgePlatform?: unknown
  titleband?: unknown
  panelCluster?: unknown
  clusterInset?: unknown
  menubar?: unknown
  wcoVisible?: unknown
  wcoRect: { x: number; y: number; width: number; height: number } | null
  wcoLeftInset?: unknown
  wcoRightInset?: unknown
  clusterRight?: unknown
  viewportWidth?: unknown
  appearanceBackdrop?: unknown
}

async function runRendererProbe(contents: WebContents, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    contents.executeJavaScript(rendererProbe),
    delay(timeoutMs).then(() => 'renderer-poll-timeout' as const),
  ])
}

/** 非 win32：沿用既有语义——按钮簇右缘距视口右缘的内缩应为 0（±50 容差）。 */
function commonProbeReady(state: CiSmokeProbe): boolean {
  return state.desktop === true
    && state.platform === process.platform
    && state.bridgePlatform === process.platform
    && state.titleband === true
    && state.panelCluster === true
}

/**
 * win32：WCO 可见且 rect 非零；左右 inset 与 rect 宽之和等于视口宽；
 * 自绘菜单栏存在；panel cluster 右缘不与 caption 区相交；appearance
 * dataset 与主进程快照一致；主进程侧 application menu 已安装且原生菜单栏
 * 已隐藏。
 */
function windowsProbeReady(state: CiSmokeProbe, expectedBackdrop: string | null): boolean {
  const rect = state.wcoRect
  if (typeof state.wcoVisible !== 'boolean' || state.wcoVisible !== true) return false
  if (rect === null || rect.width <= 0 || rect.height <= 0) return false
  if (typeof state.wcoLeftInset !== 'number' || typeof state.wcoRightInset !== 'number') return false
  if (typeof state.viewportWidth !== 'number' || typeof state.clusterRight !== 'number') return false
  const insets = state.wcoLeftInset + rect.width + state.wcoRightInset
  if (Math.abs(insets - state.viewportWidth) > 1) return false
  if (state.clusterRight < 0 || state.clusterRight > state.viewportWidth - state.wcoRightInset + 1) return false
  if (state.menubar !== true) return false
  if (state.appearanceBackdrop !== expectedBackdrop) return false
  const menuState = applicationMenuState()
  if (!menuState.installed || !menuState.barHidden) return false
  return true
}

/** 等待 desktop-frame 客户端插件完成标记，证明 preload、插件与平台桥都已装配。 */
async function waitForCiSmokeState(contents: WebContents, win: BaseWindow | null = null): Promise<void> {
  const win32 = process.platform === 'win32'
  // 渲染进程 dataset 与主进程外观快照必须一致（mica 或受支持的 solid 均可）
  const expectedBackdrop = win32 ? (windowsAppearance?.snapshot().backdrop ?? null) : null
  const deadline = Date.now() + 10_000
  let last: unknown = null
  while (Date.now() < deadline) {
    const slice = Math.min(500, Math.max(1, deadline - Date.now()))
    try {
      last = await runRendererProbe(contents, slice)
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (typeof last === 'object' && last !== null) {
      const state = last as CiSmokeProbe
      const ready = commonProbeReady(state)
        && (win32 ? windowsProbeReady(state, expectedBackdrop) : (() => {
          // clusterInset：三平台标题栏策略不同，但页面右缘都没有系统按钮
          // 占位（mac 红绿灯在左侧、linux 无 overlay、win32 的 WCO 由上方
          // windowsProbeReady 单独断言），应为 0——正数说明让位机制残留。
          const inset = typeof state.clusterInset === 'number' ? state.clusterInset : -1
          return inset >= 0 && inset <= 50
        })())
      if (ready) {
        if (win32 && state.wcoRect !== null) {
          console.log(
            `[ci-smoke] desktop-frame 标记就绪（WCO ${state.wcoRect.width}×${state.wcoRect.height}，`
            + `rightInset=${String(state.wcoRightInset)}px，clusterRight=${String(state.clusterRight)}px，`
            + `backdrop=${expectedBackdrop ?? '?'}）`,
          )
        } else {
          console.log(`[ci-smoke] desktop-frame 标记就绪（按钮簇内缩 ${String(state.clusterInset)}px）`)
        }
        if (win32) await verifyWindowsOverlayAfterMaximize(contents, win)
        return
      }
    }
    await delay(100)
  }
  throw new Error(`CI smoke: desktop plugin/preload marker 未就绪：${JSON.stringify(last)}`)
}

/**
 * win32 附加复查：最大化 → 恢复后重新读取 WCO rect 与 panel cluster，
 * 仍不得与 caption 区相交。runner 上若最大化/恢复不可靠（无真实桌面等），
 * 跳到 catch 仅告警，不把初始几何断言一起丢掉。
 */
async function verifyWindowsOverlayAfterMaximize(contents: WebContents, win: BaseWindow | null): Promise<void> {
  if (win === null || win.isDestroyed() || contents.isDestroyed()) return
  try {
    if (win.isMaximized()) win.restore()
    await delay(800)
    win.maximize()
    await delay(800)
    const probe = await runRendererProbe(contents, 3_000)
    if (typeof probe !== 'object' || probe === null) throw new Error('最大化后探测超时')
    const state = probe as CiSmokeProbe
    const rect = state.wcoRect
    if (rect === null || rect.width <= 0 || rect.height <= 0) throw new Error('最大化后 WCO rect 为空')
    if (typeof state.clusterRight !== 'number' || typeof state.viewportWidth !== 'number'
      || typeof state.wcoRightInset !== 'number') {
      throw new Error('最大化后几何缺失')
    }
    if (state.clusterRight > state.viewportWidth - state.wcoRightInset + 1) {
      throw new Error('最大化后 panel cluster 与 caption 区相交')
    }
    win.restore()
    await delay(800)
    console.log('[ci-smoke] maximize/restore 后 WCO 几何复查通过')
  } catch (error) {
    console.warn('[ci-smoke] maximize/restore 复查不稳定，保留初始几何断言', error)
  }
}

/** Windows GUI processes may not expose stdout to the workflow runner. */
function writeCiSmokeReadyMarker(): void {
  if (!ciSmoke || process.env.DSH_HOME === undefined) return
  writeFileSync(
    join(process.env.DSH_HOME, ciSmokeReadyMarker),
    `${JSON.stringify({ ready: true, platform: process.platform, pid: process.pid })}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

function webuiUrl(): string {
  if (allowedPort === null) throw new Error('agent not ready')
  return agentPageUrl(allowedPort)
}

function createMainWindow(): BaseWindow {
  // activate 与 bootstrap 不能为同一生命周期重复创建 BrowserWindow primary。
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow
  const state = loadWindowState()
  const commonOptions = {
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    title: 'DeepSeek Harness',
    // win/linux 任务栏与窗口图标（macOS 用 dock 图标，忽略此项）
    icon: appIconPath(),
  }
  const win = process.platform === 'win32'
    ? new BrowserWindow({
        ...commonOptions,
        // 无自绘菜单；保留系统 WCO 按钮，透明底与 44px titleband 对齐。
        // symbolColor 不硬编码：先让 Electron/nativeTheme 决定系统对比色，
        // 深浅切换由 appearance 控制器重应用 overlay 跟随。
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: { color: '#00000000', height: 44 },
        // 允许 primary 在窗口尚未显示时预加载，顶层 splash 会覆盖它。
        paintWhenInitiallyHidden: true,
        webPreferences: createWebuiWebPreferences(),
      })
    : new BaseWindow({
        ...commonOptions,
        // hiddenInset：红绿灯叠在内容上，无独立标题栏。不能用 transparent: true
        // （会弄没红绿灯）。backgroundColor 透明让 vibrancy 透出；webui 视图
        // 同样透明，由页面中栏自己铺实底，侧栏才能吃到桌面模糊。
        ...(process.platform === 'darwin'
          ? {
              titleBarStyle: 'hiddenInset' as const,
              trafficLightPosition: { x: 16, y: 14 },
              vibrancy: 'under-window' as const,
              visualEffectState: 'active' as const,
              backgroundColor: '#00000000',
            }
          : process.platform === 'linux'
            ? { titleBarStyle: 'hidden' as const }
            : {}),
      })
  primaryWebContents = win instanceof BrowserWindow ? win.webContents : null
  if (process.platform === 'win32' && win instanceof BrowserWindow) {
    // Mica/实底回退 + 深浅/无障碍同步；渲染进程经 preload 读快照并订阅。
    windowsAppearance = createWindowsAppearanceController(
      win,
      process.getSystemVersion(),
      nativeTheme,
      broadcastAppearance,
    )
    // 原生菜单栏不可见但 roles/accelerator 注册：自绘顶级菜单弹同一份
    // submenu，不维护第二份命令定义。
    installApplicationMenu(win)
  }
  if (state.isMaximized) win.maximize()
  trackWindowState(win)
  // macOS 惯例：关窗隐藏而非销毁——渲染进程与 SSE/WS 保持存活，点程序坞秒开；
  // Cmd+Q（quitRequested=true）时才放行真正销毁
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !quitRequested) {
      event.preventDefault()
      win.hide()
    }
  })
  win.once('closed', () => {
    if (mainWindow !== win) return
    splash?.dispose()
    splash = null
    windowsAppearance?.dispose()
    windowsAppearance = null
    primaryWebContents = null
    webuiContents = null
    mainWindow = null
  })
  return win
}

/** 外观快照广播（仅 win32 有监听者：appearance IPC 只在 Windows 装配）。 */
function broadcastAppearance(snapshot: WindowsAppearanceSnapshot): void {
  const contents = webuiContents
  if (contents !== null && !contents.isDestroyed()) {
    contents.send('dsh-desktop:appearance-changed', snapshot)
  }
}

function clearAgentTransport(): void {
  allowedPort = null
}

function sendAgentStatus(status: 'running' | 'restarting' | 'stopped'): void {
  const contents = webuiContents
  if (contents !== null && !contents.isDestroyed()) {
    contents.send('dsh-desktop:agent-status', status)
  }
}

/** 上一代 agent 的 pid 记录文件（随 userData 隔离，CI 隔离 profile 时互不干扰）。 */
function agentPidPath(): string {
  return join(app.getPath('userData'), 'dsh-agent.pid.json')
}

/** 把监管器每一代的随机端口接到导航锁，并在恢复后重载失联页面。 */
function wireSupervisor(candidate: AgentSupervisor): void {
  let recovering = false
  // 最近一代 ready 的 agent pid：exit 时按它清 pid 文件，避免误删重启后新一代写入的记录
  let lastReadyPid: number | null = null
  // 与 createSupervisor 内部同源：record 的 cliEntry 必须等于实际启动入口，
  // 下次启动收割时的命令行核身才能匹配
  const cliEntry = resolveCliEntry()
  candidate.on('ready', (ready: AgentReadyInfo) => {
    if (supervisor !== candidate || quitRequested) return
    allowedPort = ready.port
    lastReadyPid = ready.pid
    // 主进程被强杀时 before-quit 不执行，pid 文件是下次启动收割残留 agent 的唯一线索
    writeAgentPidRecord(agentPidPath(), { pid: ready.pid, cliEntry })
    sendAgentStatus('running')
    if (!recovering) return
    recovering = false
    const contents = webuiContents
    if (contents !== null && !contents.isDestroyed()) {
      void contents.loadURL(agentPageUrl(ready.port)).catch((error: unknown) => {
        console.warn('[agent] 恢复后重载 WebUI 失败', error)
      })
    }
  })
  candidate.on('exit', () => {
    if (supervisor !== candidate) return
    clearAgentTransport()
    if (lastReadyPid !== null) {
      removeAgentPidRecord(agentPidPath(), lastReadyPid)
      lastReadyPid = null
    }
  })
  candidate.on('restarting', (attempt: number, retryDelay: number) => {
    if (supervisor !== candidate || quitRequested) return
    recovering = true
    clearAgentTransport()
    console.warn(`[agent] 意外退出，第 ${attempt} 次重启（${retryDelay}ms 后）`)
    sendAgentStatus('restarting')
  })
  candidate.on('restart-failed', (error: unknown, attempt: number) => {
    if (supervisor === candidate) console.warn(`[agent] 第 ${attempt} 次重启未 ready`, error)
  })
  candidate.on('gave-up', () => {
    if (supervisor !== candidate || quitRequested) return
    clearAgentTransport()
    sendAgentStatus('stopped')
    if (ciSmoke) {
      console.error('[ci-smoke] dsh agent 多次重启失败')
    } else {
      dialog.showErrorBox('dsh agent 已停止', 'agent 多次重启失败，应用将退出。日志见 userData/logs/dsh-agent.log')
    }
    app.quit()
  })
}

/**
 * 完整启动流程：splash → agent → WebUI loadURL → 挂载检测 → 定格 → 揭幕。
 * Windows 的 WebUI 在 BrowserWindow primary 中加载；macOS/Linux 在 owned
 * child view 中加载。restart-agent 可传入已经显示的 splash 控制器，保证在
 * 停旧 agent 到导航新端口的整个间隔里遮罩连续存在。
 * 中途退出分支（generation 失效/窗口销毁）把控制器留给 closed 时统一
 * dispose；成功路径（reveal 完成）也保留控制器——resize 监听需要活到
 * 窗口关闭（仅监听，无视图；dispose 幂等）。
 */
async function runStartup(
  generation: number,
  preparedController: SplashController | null = null,
): Promise<void> {
  const win = mainWindow
  if (win === null || win.isDestroyed()) throw new Error('主窗口不可用')
  webuiContents = null
  let controller = preparedController
  if (controller === null) {
    splash?.dispose()
    controller = createSplashController(
      win,
      primaryWebContents === null ? {} : { primary: primaryWebContents },
    )
    splash = controller
    await controller.attachSplash()
  } else {
    splash = controller
  }
  if (generation !== startupGeneration || mainWindow !== win || quitRequested) return

  // starting 阶段提前推送：首启解压（仅打包态）期间水位 creep 持续兜底
  controller.sendPhase('starting')
  if (app.isPackaged) {
    // 安装产物只携带单个 dsh-cli.tar；首启（或版本/产物变更）解压到 userData
    await ensureDshRuntime({
      userDataDir: app.getPath('userData'),
      version: app.getVersion(),
      archivePath: join(process.resourcesPath, 'dsh-cli.tar'),
    })
    if (generation !== startupGeneration || mainWindow !== win || quitRequested) return
  }

  const candidate = createSupervisor()
  supervisor = candidate
  wireSupervisor(candidate)

  controller.sendProgress(5)
  const ready = await candidate.start()
  if (generation !== startupGeneration || supervisor !== candidate || quitRequested) {
    await candidate.stop()
    return
  }
  allowedPort = ready.port
  controller.sendProgress(70)
  controller.sendPhase('loading')

  const target = controller.attachWebui({ visible: false })
  const contents = target.contents
  webuiContents = contents
  await contents.loadURL(agentPageUrl(ready.port))
  const mounted = await controller.waitForMount(contents, MOUNT_TIMEOUT_MS)
  if (generation !== startupGeneration || supervisor !== candidate || quitRequested) return
  if (!mounted) {
    if (ciSmoke) throw new Error('CI smoke: WebUI 挂载检测超时')
    console.warn('[splash] 应用挂载检测超时，强制揭幕')
  }

  controller.sendProgress(100)
  controller.sendPhase('sealed')
  await delay(SEAL_TOTAL_MS)
  if (generation !== startupGeneration || supervisor !== candidate || quitRequested) return
  await controller.reveal()
  if (ciSmoke) {
    await waitForCiSmokeState(contents, win)
    writeCiSmokeReadyMarker()
    console.log(`[ci-smoke] DSH_DESKTOP_READY platform=${process.platform}`)
    setImmediate(() => app.quit())
  }
}

function startStartup(preparedController: SplashController | null = null): Promise<void> {
  if (startupTask !== null) return startupTask
  const generation = ++startupGeneration
  const task = runStartup(generation, preparedController)
  startupTask = task
  void task.finally(() => {
    if (startupTask === task) startupTask = null
  }).catch(() => {
    // 原始 task 的调用方负责报告；这里只消费 finally 链产生的镜像拒绝。
  })
  return task
}

function reportStartupFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  splash?.sendPhase('error', message)
  if (ciSmoke) console.error(`[ci-smoke] startup failed: ${message}`)
  else dialog.showErrorBox('dsh agent 启动失败', message)
  app.quit()
}

async function bootstrap(): Promise<void> {
  installSecurityHooks(() => allowedPort)
  // dev 态 dock 图标（打包态由 app bundle 的 icns 提供，无需设置）
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(nativeImage.createFromPath(appIconPath()))
  }
  // 收割上一代残留 agent：主进程被 SIGKILL/崩溃时 before-quit 不执行，
  // detached 子进程会独活并继续持有 ~/.dsh 与 API key。dev 态 vendor 未构建
  // 时 resolveCliEntry 会抛，与收割异常一样只告警，不阻断启动。
  try {
    await reapOrphanedAgent(agentPidPath(), resolveCliEntry(), defaultReapDeps())
  } catch (error) {
    console.warn('[agent] 收割残留 agent 失败', error)
  }
  mainWindow = createMainWindow()
  try {
    await startStartup()
  } catch (err) {
    reportStartupFailure(err)
  }
}

ipcMain.handle('dsh-desktop:restart-agent', async (event) => {
  if (!isTrustedIpcSender(event) || event.sender !== webuiContents) {
    throw new Error('unauthorized IPC sender')
  }
  if (mainWindow === null || quitRequested) return
  if (restartTask !== null) return restartTask
  const task = (async () => {
    if (startupTask !== null) await startupTask.catch(() => {})
    const win = mainWindow
    const current = supervisor
    if (win === null || win.isDestroyed() || quitRequested) return
    // 重启顺序：先铺 splash 盖住旧页面（Windows 为不透明层，primary 跨
    // 代复用无需销毁），再停止旧 agent，最后 startStartup 导航新端口——
    // 旧页/about:blank 不会在任何间隙闪现。
    splash?.dispose()
    splash = null
    const controller = createSplashController(
      win,
      primaryWebContents === null ? {} : { primary: primaryWebContents },
    )
    splash = controller
    await controller.attachSplash()
    sendAgentStatus('restarting')
    webuiContents = null
    if (current !== null) {
      try {
        await current.stop()
      } catch (error) {
        console.warn('[agent] 重启时停止旧 agent 失败', error)
      }
    }
    clearAgentTransport()
    try {
      await startStartup(controller)
    } catch (err) {
      reportStartupFailure(err)
      throw err
    }
  })()
  restartTask = task
  void task.finally(() => {
    if (restartTask === task) restartTask = null
  }).catch(() => {
    // invoke 的返回 Promise 保留错误；消费 finally 链的镜像拒绝。
  })
  return task
})

const APPEARANCE_CHANNEL = 'dsh-desktop:appearance-get'
const THEME_SOURCE_CHANNEL = 'dsh-desktop:theme-source'

ipcMain.handle(APPEARANCE_CHANNEL, (event) => {
  if (!isTrustedIpcSender(event) || event.sender !== webuiContents) {
    throw new Error('unauthorized IPC sender')
  }
  return windowsAppearance?.snapshot() ?? null
})

ipcMain.handle(THEME_SOURCE_CHANNEL, (event, source: unknown) => {
  if (!isTrustedIpcSender(event) || event.sender !== webuiContents) {
    throw new Error('unauthorized IPC sender')
  }
  if (!isNativeThemeSource(source)) throw new Error('invalid theme source')
  windowsAppearance?.setThemeSource(source)
})

ipcMain.handle('dsh-desktop:menu-popup', (event, payload: unknown) => {
  if (!isTrustedIpcSender(event) || event.sender !== webuiContents) {
    throw new Error('unauthorized IPC sender')
  }
  const win = mainWindow
  if (win === null || win.isDestroyed() || quitRequested) return false
  if (typeof payload !== 'object' || payload === null) throw new Error('invalid menu payload')
  const { id, anchor } = payload as { id?: unknown; anchor?: unknown }
  // renderer 只能传闭合 menu id + anchor 矩形；模板与坐标换算都在主进程。
  if (!isApplicationMenuId(id)) throw new Error('invalid menu id')
  if (!isValidPopupAnchor(anchor)) throw new Error('invalid menu anchor')
  if (process.platform !== 'win32') return false
  const contents = event.sender
  return popupApplicationMenu({
    win,
    contents,
    id,
    anchor,
    onClosed: (closedId) => {
      if (!contents.isDestroyed()) contents.send('dsh-desktop:menu-closed', closedId)
    },
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    if (ciSmoke) console.error(`[ci-smoke] bootstrap failed: ${message}`)
    else dialog.showErrorBox('启动失败', message)
    app.quit()
  })

  app.on('activate', () => {
    // 被隐藏的窗口直接显示（渲染进程一直存活，无重载）；已销毁才重建。
    // createMainWindow 自身也有生命周期保护，避免重复创建 BrowserWindow primary。
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      return
    }
    mainWindow = createMainWindow()
    // agent 还活着：直挂 WebUI 立即显示，不重播启动动画。controller 保留在
    // splash 变量里：其 resize 监听需要活到窗口关闭（Windows 下没有 splash
    // 视图，仅注册监听不创建视图；dispose 幂等，close 时一并注销）。
    if (allowedPort !== null && supervisor !== null && supervisor.state !== 'stopped') {
      splash = createSplashController(
        mainWindow,
        primaryWebContents === null ? {} : { primary: primaryWebContents },
      )
      const target = splash.attachWebui({ visible: true })
      webuiContents = target.contents
      void target.contents.loadURL(webuiUrl())
      mainWindow.show()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitRequested) return
    quitRequested = true
    startupGeneration += 1
    splash?.dispose()
    if (!supervisor || supervisor.state === 'stopped') {
      clearAgentTransport()
      return
    }
    const current = supervisor
    event.preventDefault()
    clearAgentTransport()
    // stop 失败（如 SIGKILL 后 5s 未关闭）也必须放行退出，不能挂住 quit
    void current.stop()
      .catch((error: unknown) => { console.error('[agent] 退出前停止 agent 失败', error) })
      .finally(() => app.quit())
  })
}
