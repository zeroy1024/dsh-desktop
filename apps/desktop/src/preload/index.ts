/**
 * preload — 向 dsh webui 暴露最小桌面能力。
 * sandbox 模式下只能使用 electron 的 ipcRenderer/contextBridge，输出必须为 CJS。
 *
 * launch token 不进页面：当前上游无 token 消费者；即便 ready 行再带 token，
 * 也留在主进程，不挂到 window、不进文档 URL。
 *
 * Windows 外观/菜单通道（win32 专用）：
 * - getAppearance/onAppearanceChanged：主进程外观快照（Mica/solid、深浅、
 *   forced colors、减少透明度），渲染进程据此写 dataset 供 CSS 分支；
 * - setNativeThemeSource：按 WebUI 主题偏好驱动 nativeTheme.themeSource，
 *   让 caption glyph 与 Mica 跟随页面主题；
 * - showApplicationMenu/onApplicationMenuClosed：只传闭合 menu id + anchor
 *   矩形，菜单模板与坐标换算全部在主进程。
 * 所有 handler 都经 isTrustedIpcSender 校验当前 agent 主 frame。
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
  getAppearance: (): Promise<unknown> => ipcRenderer.invoke('dsh-desktop:appearance-get'),
  onAppearanceChanged: (listener: (snapshot: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => listener(snapshot)
    ipcRenderer.on('dsh-desktop:appearance-changed', wrapped)
    return () => ipcRenderer.removeListener('dsh-desktop:appearance-changed', wrapped)
  },
  setNativeThemeSource: (source: 'system' | 'light' | 'dark'): Promise<void> =>
    ipcRenderer.invoke('dsh-desktop:theme-source', source),
  showApplicationMenu: (
    id: string,
    anchor: { x: number; y: number; width: number; height: number },
  ): Promise<boolean> => ipcRenderer.invoke('dsh-desktop:menu-popup', { id, anchor }),
  onApplicationMenuClosed: (listener: (id: string) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, id: string): void => listener(id)
    ipcRenderer.on('dsh-desktop:menu-closed', wrapped)
    return () => ipcRenderer.removeListener('dsh-desktop:menu-closed', wrapped)
  },
})