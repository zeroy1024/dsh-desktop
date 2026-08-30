/**
 * preload — 向 dsh webui 暴露最小桌面能力，以及 P3 WebSocket IPC。
 * sandbox 模式下只能使用 electron 的 ipcRenderer/contextBridge，输出必须为 CJS。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  /** unpackaged 主进程通过 additionalArguments 注入 --dsh-dev */
  dev: process.argv.includes('--dsh-dev'),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  restartAgent: (): Promise<void> => ipcRenderer.invoke('dsh-desktop:restart-agent'),
  onAgentStatus: (listener: (status: string) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: string): void => listener(status)
    ipcRenderer.on('dsh-desktop:agent-status', wrapped)
    return () => ipcRenderer.removeListener('dsh-desktop:agent-status', wrapped)
  },
  /** 同步分配 id 并通知主进程去连 agent WS；垫片靠这个避免丢首帧。 */
  wsOpen: (path: string): string => {
    if (typeof path !== 'string' || path.length === 0 || path.length > 2048) {
      throw new TypeError('invalid WebSocket path')
    }
    const id = crypto.randomUUID()
    ipcRenderer.send('dsh-bridge:ws-open', { id, path })
    return id
  },
  wsClose: (id: string): void => {
    if (typeof id !== 'string' || id.length > 128) return
    ipcRenderer.send('dsh-bridge:ws-close', id)
  },
  onWsEvent: (
    listener: (ev: { id: string; type: string; data?: string }) => void,
  ): (() => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      ev: { id: string; type: string; data?: string },
    ): void => listener(ev)
    ipcRenderer.on('dsh-bridge:ws-event', wrapped)
    return () => ipcRenderer.removeListener('dsh-bridge:ws-event', wrapped)
  },
})
