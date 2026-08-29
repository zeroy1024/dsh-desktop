/**
 * index.ts — Electron 主进程入口。
 *
 * 启动顺序：单实例锁 → 安全钩子 → 建隐藏主窗口 → 起 dsh agent 子进程 →
 * 拿到带 token 的 ready URL → loadURL → 显示窗口。退出时先停 agent。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { createSupervisor } from './agent'
import { installSecurityHooks } from './security'
import { loadWindowState, trackWindowState } from './window-state'
import type { AgentSupervisor } from '@dsh-desktop/agent-host'

let supervisor: AgentSupervisor | null = null
let mainWindow: BrowserWindow | null = null
/** 允许渲染进程导航的 origin（agent ready 后设置）。 */
let allowedOrigin: string | null = null
let quitRequested = false

function createMainWindow(): BrowserWindow {
  const state = loadWindowState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (state.isMaximized) win.maximize()
  trackWindowState(win)
  win.once('ready-to-show', () => win.show())
  return win
}

/** 启动一个新 agent 并把窗口导航到它的 ready URL。 */
async function startAgentAndLoad(): Promise<void> {
  supervisor = createSupervisor()
  supervisor.on('restarting', (attempt: number) => {
    console.warn(`[agent] 意外退出，第 ${attempt} 次重启`)
    mainWindow?.webContents.send('dsh-desktop:agent-status', 'restarting')
  })
  supervisor.on('gave-up', () => {
    dialog.showErrorBox('dsh agent 已停止', 'agent 多次重启失败，应用将退出。日志见 userData/logs/dsh-agent.log')
    app.quit()
  })
  const ready = await supervisor.start()
  allowedOrigin = `http://127.0.0.1:${ready.port}`
  await mainWindow!.loadURL(ready.url)
}

async function bootstrap(): Promise<void> {
  installSecurityHooks(() => allowedOrigin)
  mainWindow = createMainWindow()
  try {
    await startAgentAndLoad()
  } catch (err) {
    dialog.showErrorBox('dsh agent 启动失败', err instanceof Error ? err.message : String(err))
    app.quit()
  }
}

ipcMain.handle('dsh-desktop:restart-agent', async () => {
  if (!mainWindow) return
  if (supervisor) await supervisor.stop()
  allowedOrigin = null
  await startAgentAndLoad()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((err: unknown) => {
    dialog.showErrorBox('启动失败', err instanceof Error ? err.message : String(err))
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      if (allowedOrigin) void mainWindow.loadURL(allowedOrigin)
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
