/**
 * splash preload — 向启动层暴露平台信息与启动进度/阶段订阅。
 * sandbox 模式下只能使用 electron 的 ipcRenderer/contextBridge，输出必须为 CJS。
 * 通道只进不出，启动层无任何回写主进程的能力。
 */
import { contextBridge, ipcRenderer } from 'electron'

type SplashPhase = 'starting' | 'loading' | 'sealed' | 'revealed' | 'error'

contextBridge.exposeInMainWorld('dshSplash', {
  platform: process.platform,
  /** 订阅启动百分比（0-100，主进程按关键节点上报）。 */
  onProgress: (listener: (percent: number) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, percent: number): void => listener(percent)
    ipcRenderer.on('dsh-splash:progress', wrapped)
    return () => ipcRenderer.removeListener('dsh-splash:progress', wrapped)
  },
  /** 订阅阶段迁移；error 阶段附带可读原因。 */
  onPhase: (listener: (phase: SplashPhase, message?: string) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, phase: SplashPhase, message?: string): void =>
      listener(phase, message)
    ipcRenderer.on('dsh-splash:phase', wrapped)
    return () => ipcRenderer.removeListener('dsh-splash:phase', wrapped)
  },
})
