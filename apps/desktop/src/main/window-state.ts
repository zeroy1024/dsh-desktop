/**
 * window-state.ts — 主窗口尺寸/位置记忆，存 userData/window-state.json。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, screen, type BaseWindow } from 'electron'
import { normalizeWindowState, type WindowState } from './window-state-model'

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 读取上次的窗口状态；文件缺失或损坏时回落到默认尺寸。 */
export function loadWindowState(): WindowState {
  let parsed: Partial<WindowState> = {}
  try {
    if (existsSync(stateFile())) {
      parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<WindowState>
    }
  } catch {
    // 损坏的状态文件不值得阻断启动，回落默认
  }
  const primary = screen.getPrimaryDisplay().workArea
  return normalizeWindowState(parsed, screen.getAllDisplays().map((display) => display.workArea), primary)
}

/** 监听窗口变化，关闭时把 bounds 写盘。 */
export function trackWindowState(win: BaseWindow): void {
  win.on('close', () => {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, isMaximized }
    const file = stateFile()
    const temporary = `${file}.${String(process.pid)}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      // 写盘失败不影响退出
    } finally {
      rmSync(temporary, { force: true })
    }
  })
}
