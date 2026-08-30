/**
 * security.ts — 渲染进程安全基线。
 *
 * dsh webui 只需要与 127.0.0.1 上的 agent 通信：拒绝一切权限请求、
 * 禁止 window.open、导航只允许 agent origin，其余一律交给系统浏览器。
 */
import {
  app,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { isDshRendererUrl } from '@dsh-desktop/bridge'

function externalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function openExternal(value: string): void {
  const safe = externalHttpUrl(value)
  if (safe === null) return
  void shell.openExternal(safe).catch((error: unknown) => {
    console.warn('[security] 无法打开外部链接', error)
  })
}

/** IPC 只接受固定 dsh origin 的主 frame，拒绝子 frame 与其他 WebContents。 */
export function isTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return frame !== null && frame === event.sender.mainFrame && isDshRendererUrl(frame.url)
}

/**
 * 安装全局安全钩子。
 *
 * 放行规则是常量级的：只允许固定 origin `dsh://127.0.0.1`（由
 * `isDshRendererUrl` 精确判定）。origin 字符串本身不参与判断。
 *
 * @param isAgentReady - agent 是否已 ready。未 ready 时拒绝一切页内导航，
 *   防止 ready 前的空窗期被导航到别处。
 */
export function installSecurityHooks(isAgentReady: () => boolean): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isAgentReady() && isDshRendererUrl(url)) return
      event.preventDefault()
      openExternal(url)
    })
  })
}
