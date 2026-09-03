/**
 * index.ts — Electron 主进程入口。
 *
 * 启动顺序：单实例锁 → 安全钩子 → 收割上一代残留 agent（pid 文件核身）
 * → 建隐藏 BaseWindow → splash → 起 dsh agent
 * → 渲染进程 loadURL(http://127.0.0.1:<port>/) → 挂载检测 → 定格 → 揭幕。
 *
 * 用 BaseWindow 而不是 BrowserWindow：后者自带一块 default webContents，
 * 半透明 splash 会把那块（或 loadURL 上去的 webui）合成进来，透出的是应用
 * 而不是桌面。BaseWindow 没有默认页面，合成栈里只有我们放的两个视图。
 */
import { app, BaseWindow, dialog, ipcMain, nativeImage, type WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentPageUrl } from '@dsh-desktop/bridge'
import { createSupervisor } from './agent'
import { defaultReapDeps, reapOrphanedAgent, removeAgentPidRecord, writeAgentPidRecord } from './orphan-reaper'
import { resolveCliEntry } from './paths'
import { ensureDshRuntime } from './runtime-archive'
import { installSecurityHooks, isTrustedIpcSender } from './security'
import {
  MOUNT_TIMEOUT_MS,
  SEAL_TOTAL_MS,
  createSplashController,
  type SplashController,
} from './splash'
import { loadWindowState, trackWindowState } from './window-state'
import type { AgentReadyInfo, AgentSupervisor } from '@dsh-desktop/agent-host'

let supervisor: AgentSupervisor | null = null
let mainWindow: BaseWindow | null = null
let splash: SplashController | null = null
let webuiView: WebContentsView | null = null
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

/** 等待 desktop-frame 客户端插件完成标记，证明 preload、插件与平台桥都已装配。 */
async function waitForCiSmokeState(view: WebContentsView): Promise<void> {
  const deadline = Date.now() + 10_000
  let last: unknown = null
  while (Date.now() < deadline) {
    const slice = Math.min(500, Math.max(1, deadline - Date.now()))
    try {
      last = await Promise.race([
        view.webContents.executeJavaScript(`(() => {
          // apply() 前几行的 dataset 标记之外，还断言按钮簇真实渲染：
          // loader entry 半死（apply 后半段抛错）时 Titleband 与面板簇
          // 都不渲染，dataset 标记却已写入——0.0.3 的 Windows 残缺 UI
          // 正是从这个缺口漏过去的。内缩量用几何而非样式字符串断言：
          // getComputedStyle 对自定义属性返回未求值的 calc() token，
          // 而 cluster 右缘距视口右缘的内缩是可靠数字。
          const cluster = document.querySelector('[data-dsh-panel-cluster]')
          const titleband = document.querySelector('[data-dsh-titleband]')
          const inset = cluster === null
            ? -1
            : Math.round(window.innerWidth - cluster.getBoundingClientRect().right)
          return {
            desktop: document.documentElement.hasAttribute('data-dsh-desktop'),
            platform: document.documentElement.dataset.dshPlatform,
            bridgePlatform: window.dshDesktop?.platform,
            titleband: titleband !== null,
            panelCluster: cluster !== null,
            clusterInset: inset,
          }
        })()`),
        delay(slice).then(() => 'renderer-poll-timeout' as const),
      ])
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (typeof last === 'object' && last !== null) {
      const state = last as {
        desktop?: unknown
        platform?: unknown
        bridgePlatform?: unknown
        titleband?: unknown
        panelCluster?: unknown
        clusterInset?: unknown
      }
      // clusterInset：按钮簇右缘距视口右缘的内缩。三平台标题栏策略不同，但
      // 页面右缘都没有系统按钮占位（mac 红绿灯在左侧、win 原生标题栏在页面
      // 之外、linux 无 overlay），应为 0——正数说明让位机制残留或布局异常。
      const inset = typeof state.clusterInset === 'number' ? state.clusterInset : -1
      if (state.desktop === true
        && state.platform === process.platform
        && state.bridgePlatform === process.platform
        && state.titleband === true
        && state.panelCluster === true
        && inset >= 0 && inset <= 50) {
        console.log(`[ci-smoke] desktop-frame 标记就绪（按钮簇内缩 ${inset}px）`)
        return
      }
    }
    await delay(100)
  }
  throw new Error(`CI smoke: desktop plugin/preload marker 未就绪：${JSON.stringify(last)}`)
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
  const state = loadWindowState()
  const win = new BaseWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    title: 'DeepSeek Harness',
    // win/linux 任务栏与窗口图标（macOS 用 dock 图标，忽略此项）
    icon: appIconPath(),
    // hiddenInset：红绿灯叠在内容上，无独立标题栏。不能用 transparent: true
    // （会弄没红绿灯）。backgroundColor 透明让 vibrancy 透出；webui 视图
    // 同样透明，由页面中栏自己铺实底，侧栏才能吃到桌面模糊。
    // Windows 用原生标题栏：WebUI 挂在 WebContentsView 里，Chromium 不把
    // WCO 状态接线到该渲染端（env()/getTitlebarAreaRect 恒为 0），hidden +
    // titleBarOverlay 的自绘三键无法被页面让位（0.0.3/0.0.4 两版真机按钮
    // 叠加回归），原生标题栏让三键/snap layout/无障碍全部回归系统托管。
    // Linux 维持 hidden（无三键的既有状态，另行决策，本变更不动）。
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
    webuiView = null
    mainWindow = null
  })
  return win
}

function clearAgentTransport(): void {
  allowedPort = null
}

function sendAgentStatus(status: 'running' | 'restarting' | 'stopped'): void {
  const view = webuiView
  if (view !== null && !view.webContents.isDestroyed()) {
    view.webContents.send('dsh-desktop:agent-status', status)
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
    const view = webuiView
    if (view !== null && !view.webContents.isDestroyed()) {
      void view.webContents.loadURL(agentPageUrl(ready.port)).catch((error: unknown) => {
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
 * 完整启动流程：splash → agent → 隐藏的 webui 视图 loadURL → 挂载检测 → 定格 → 揭幕。
 * 首启与 restart-agent 共用；重入时先清场旧视图。
 */
async function runStartup(generation: number): Promise<void> {
  const win = mainWindow
  if (win === null || win.isDestroyed()) throw new Error('主窗口不可用')
  splash?.dispose()
  webuiView = null
  const controller = createSplashController(win)
  splash = controller
  await controller.attachSplash()
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

  const view = controller.attachWebui({ visible: false })
  webuiView = view
  await view.webContents.loadURL(agentPageUrl(ready.port))
  const mounted = await controller.waitForMount(view, MOUNT_TIMEOUT_MS)
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
    await waitForCiSmokeState(view)
    writeCiSmokeReadyMarker()
    console.log(`[ci-smoke] DSH_DESKTOP_READY platform=${process.platform}`)
    setImmediate(() => app.quit())
  }
}

function startStartup(): Promise<void> {
  if (startupTask !== null) return startupTask
  const generation = ++startupGeneration
  const task = runStartup(generation)
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
  if (!isTrustedIpcSender(event)) throw new Error('unauthorized IPC sender')
  if (mainWindow === null || quitRequested) return
  if (restartTask !== null) return restartTask
  const task = (async () => {
    if (startupTask !== null) await startupTask.catch(() => {})
    const current = supervisor
    if (current !== null) await current.stop()
    clearAgentTransport()
    splash?.dispose()
    splash = null
    webuiView = null
    try {
      await startStartup()
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
    // 被隐藏的窗口直接显示（渲染进程一直存活，无重载）；已销毁才重建
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      return
    }
    mainWindow = createMainWindow()
    // agent 还活着：直挂 webui 立即显示，不重播启动动画
    if (allowedPort !== null && supervisor !== null && supervisor.state !== 'stopped') {
      splash = createSplashController(mainWindow)
      webuiView = splash.attachWebui({ visible: true })
      void webuiView.webContents.loadURL(webuiUrl())
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
