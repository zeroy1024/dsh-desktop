/**
 * window-state.ts — 主窗口尺寸/位置记忆，存 userData/window-state.json。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800 }

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 读取上次的窗口状态；文件缺失或损坏时回落到默认尺寸。 */
export function loadWindowState(): WindowState {
  try {
    if (existsSync(stateFile())) {
      const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<WindowState>
      if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
        return { ...DEFAULT_STATE, ...parsed }
      }
    }
  } catch {
    // 损坏的状态文件不值得阻断启动，回落默认
  }
  return { ...DEFAULT_STATE }
}

/** 监听窗口变化，关闭时把 bounds 写盘。 */
export function trackWindowState(win: BrowserWindow): void {
  win.on('close', () => {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, isMaximized }
    try {
      writeFileSync(stateFile(), JSON.stringify(state))
    } catch {
      // 写盘失败不影响退出
    }
  })
}
