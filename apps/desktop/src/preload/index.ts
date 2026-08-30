/**
 * preload — 向 dsh webui 暴露最小桌面能力。
 * sandbox 模式下只能使用 electron 的 ipcRenderer/contextBridge，输出必须为 CJS。
 *
 * launch token 不进页面：当前上游无 token 消费者；即便 ready 行再带 token，
 * 也留在主进程，不挂到 window、不进文档 URL。
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
})
