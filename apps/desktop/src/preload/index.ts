/**
 * preload — 以 contextBridge 向 dsh webui 暴露最小的桌面能力。
 * sandbox 模式下只能使用 electron 的 ipcRenderer/contextBridge，输出必须为 CJS。
 * P3 的 fetch-over-IPC 桥也在此处注入。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** 重启 dsh agent 并重新加载页面（当前会话会丢失）。 */
  restartAgent: (): Promise<void> => ipcRenderer.invoke('dsh-desktop:restart-agent'),
  /** 订阅 agent 状态变化（如自动重启）。 */
  onAgentStatus: (listener: (status: string) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: string): void => listener(status)
    ipcRenderer.on('dsh-desktop:agent-status', wrapped)
    return () => ipcRenderer.removeListener('dsh-desktop:agent-status', wrapped)
  },
})
