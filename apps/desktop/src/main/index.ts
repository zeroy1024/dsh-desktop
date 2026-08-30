/**
 * index.ts — Electron 主进程入口。
 *
 * 启动顺序：单实例锁 → 安全钩子 → 建隐藏 BaseWindow → splash → 起 dsh agent
 * → 渲染进程 loadURL(http://127.0.0.1:<port>/) → 挂载检测 → 定格 → 揭幕。
 *
 * 用 BaseWindow 而不是 BrowserWindow：后者自带一块 default webContents，
 * 半透明 splash 会把那块（或 loadURL 上去的 webui）合成进来，透出的是应用
 * 而不是桌面。BaseWindow 没有默认页面，合成栈里只有我们放的两个视图。
 */
import { app, BaseWindow, dialog, ipcMain, nativeImage, type WebContentsView } from 'electron'
import { join } from 'node:path'
import { agentPageUrl } from '@dsh-desktop/bridge'
import { createSupervisor } from './agent'
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

// dev 态 macOS 菜单栏应用名取的是 Electron 二进制的 CFBundleName，productName
// 管不到它，必须显式 setName（值与 productName 一致，userData 路径不变）
app.setName('DeepSeek Harness')

/** 应用图标（resources/icons/icon.png，dist 的上一级）。 */
function appIconPath(): string {
  return join(import.meta.dirname, '..', 'resources', 'icons', 'icon.png')
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 14 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : {
          titleBarStyle: 'hidden' as const,
        }),
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

/** 把监管器每一代的随机端口接到导航锁，并在恢复后重载失联页面。 */
function wireSupervisor(candidate: AgentSupervisor): void {
  let recovering = false
  candidate.on('ready', (ready: AgentReadyInfo) => {
    if (supervisor !== candidate || quitRequested) return
    allowedPort = ready.port
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
    if (supervisor === candidate) clearAgentTransport()
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
    dialog.showErrorBox('dsh agent 已停止', 'agent 多次重启失败，应用将退出。日志见 userData/logs/dsh-agent.log')
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

  const candidate = createSupervisor()
  supervisor = candidate
  wireSupervisor(candidate)

  controller.sendPhase('starting')
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
  if (!mounted) console.warn('[splash] 应用挂载检测超时，强制揭幕')

  controller.sendProgress(100)
  controller.sendPhase('sealed')
  await delay(SEAL_TOTAL_MS)
  if (generation !== startupGeneration || supervisor !== candidate || quitRequested) return
  await controller.reveal()
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
  dialog.showErrorBox('dsh agent 启动失败', message)
  app.quit()
}

async function bootstrap(): Promise<void> {
  installSecurityHooks(() => allowedPort)
  // dev 态 dock 图标（打包态由 app bundle 的 icns 提供，无需设置）
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(nativeImage.createFromPath(appIconPath()))
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
    dialog.showErrorBox('启动失败', err instanceof Error ? err.message : String(err))
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
    void current.stop().finally(() => app.quit())
  })
}
