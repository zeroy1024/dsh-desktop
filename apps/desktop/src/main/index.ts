/**
 * index.ts — Electron 主进程入口。
 *
 * 启动顺序：单实例锁 → 安全钩子 → 建隐藏 BaseWindow（darwin 带 vibrancy）→
 * 挂 splash 视图并显示窗口 → 起 dsh agent → ready 后在底层 webui 视图加载
 * （揭幕前 setVisible(false)，不参与合成）→ 轮询应用挂载 → 定格字标 →
 * 揭幕摘除 splash。退出时先停 agent。
 *
 * 用 BaseWindow 而不是 BrowserWindow：后者自带一块 default webContents，
 * 半透明 splash 会把那块（或 loadURL 上去的 webui）合成进来，透出的是应用
 * 而不是桌面。BaseWindow 没有默认页面，合成栈里只有我们放的两个视图。
 */
import { app, BaseWindow, dialog, ipcMain, nativeImage, type WebContentsView } from 'electron'
import { join } from 'node:path'
import { createSupervisor } from './agent'
import { installSecurityHooks } from './security'
import {
  MOUNT_TIMEOUT_MS,
  SEAL_TOTAL_MS,
  createSplashController,
  type SplashController,
} from './splash'
import { loadWindowState, trackWindowState } from './window-state'
import type { AgentSupervisor } from '@dsh-desktop/agent-host'

let supervisor: AgentSupervisor | null = null
let mainWindow: BaseWindow | null = null
let splash: SplashController | null = null
let webuiView: WebContentsView | null = null
/** 允许渲染进程导航的 origin（agent ready 后设置）。 */
let allowedOrigin: string | null = null
/** agent 最近一次 ready 的带 token URL（activate 重建窗口时直挂 webui）。 */
let readyUrl: string | null = null
let quitRequested = false

// dev 态 macOS 菜单栏应用名取的是 Electron 二进制的 CFBundleName，productName
// 管不到它，必须显式 setName（值与 productName 一致，userData 路径不变）
app.setName('DeepSeek Harness')

/** 应用图标（resources/icons/icon.png，dist 的上一级）。 */
function appIconPath(): string {
  return join(import.meta.dirname, '..', 'resources', 'icons', 'icon.png')
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    // darwin：vibrancy 是启动层高斯模糊的氛围来源。不能用 transparent: true
    // （会弄没原生标题栏与红绿灯）。backgroundColor 透明让材质透出；
    // webui 视图不透明，揭幕后盖住材质，不影响日常窗口观感。
    ...(process.platform === 'darwin'
      ? {
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
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
  return win
}

/**
 * 完整启动流程：splash → agent → 隐藏的 webui 视图 loadURL → 挂载检测 → 定格 → 揭幕。
 * 首启与 restart-agent 共用；重入时先清场旧视图。
 */
async function runStartup(): Promise<void> {
  const win = mainWindow!
  splash?.dispose()
  webuiView = null
  splash = createSplashController(win)
  await splash.attachSplash()

  supervisor = createSupervisor()
  supervisor.on('restarting', (attempt: number) => {
    console.warn(`[agent] 意外退出，第 ${attempt} 次重启`)
    webuiView?.webContents.send('dsh-desktop:agent-status', 'restarting')
  })
  supervisor.on('gave-up', () => {
    dialog.showErrorBox('dsh agent 已停止', 'agent 多次重启失败，应用将退出。日志见 userData/logs/dsh-agent.log')
    app.quit()
  })

  splash.sendPhase('starting')
  splash.sendProgress(5)
  const ready = await supervisor.start()
  allowedOrigin = `http://127.0.0.1:${ready.port}`
  readyUrl = ready.url
  splash.sendProgress(70)
  splash.sendPhase('loading')

  webuiView = splash.attachWebui({ visible: false })
  await webuiView.webContents.loadURL(ready.url)
  const mounted = await splash.waitForMount(webuiView, MOUNT_TIMEOUT_MS)
  if (!mounted) console.warn('[splash] 应用挂载检测超时，强制揭幕')

  splash.sendProgress(100)
  splash.sendPhase('sealed')
  await delay(SEAL_TOTAL_MS)
  await splash.reveal()
}

function reportStartupFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  splash?.sendPhase('error', message)
  dialog.showErrorBox('dsh agent 启动失败', message)
  app.quit()
}

async function bootstrap(): Promise<void> {
  installSecurityHooks(() => allowedOrigin)
  // dev 态 dock 图标（打包态由 app bundle 的 icns 提供，无需设置）
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(nativeImage.createFromPath(appIconPath()))
  }
  mainWindow = createMainWindow()
  try {
    await runStartup()
  } catch (err) {
    reportStartupFailure(err)
  }
}

ipcMain.handle('dsh-desktop:restart-agent', async () => {
  if (!mainWindow) return
  if (supervisor) await supervisor.stop()
  allowedOrigin = null
  readyUrl = null
  try {
    await runStartup()
  } catch (err) {
    reportStartupFailure(err)
  }
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
    if (readyUrl !== null && supervisor !== null && supervisor.state !== 'stopped') {
      splash = createSplashController(mainWindow)
      webuiView = splash.attachWebui({ visible: true })
      void webuiView.webContents.loadURL(readyUrl)
      mainWindow.show()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitRequested || !supervisor || supervisor.state === 'stopped') return
    event.preventDefault()
    const current = supervisor
    quitRequested = true
    void current.stop().finally(() => app.quit())
  })
}
