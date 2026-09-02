/**
 * security.ts — 渲染进程安全基线。
 *
 * dsh webui 只与当前这一代 agent 的 127.0.0.1:<port> 通信：权限默认全拒、
 * 仅按白名单放行剪贴板写入，禁止 window.open、导航只允许该 origin，
 * 其余一律交给系统浏览器。
 */
import {
  app,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { isAgentRendererUrl } from '@dsh-desktop/bridge'
import { isPermissionAllowed } from './permissions'

let allowedPort: () => number | null = () => null

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

/** IPC 只接受当前 agent origin 的主 frame，拒绝子 frame 与其他 WebContents。 */
export function isTrustedIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const port = allowedPort()
  const frame = event.senderFrame
  return port !== null
    && frame !== null
    && frame === event.sender.mainFrame
    && isAgentRendererUrl(frame.url, port)
}

/**
 * 安装全局安全钩子。
 *
 * @param getAllowedPort - 当前 agent 监听端口；null 表示未 ready，拒绝一切页内导航。
 */
export function installSecurityHooks(getAllowedPort: () => number | null): void {
  allowedPort = getAllowedPort
  // Chromium 的剪贴板写入会分别命中 request（异步授权）与 check（同步检查）
  // 两条钩子：clipboard-sanitized-write 任一条被拒，navigator.clipboard.writeText
  // 都会抛 NotAllowedError，上游全部复制控件随之失效，因此两处共用同一判定。
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, getAllowedPort()))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, getAllowedPort()))

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      const port = getAllowedPort()
      if (port !== null && isAgentRendererUrl(url, port)) return
      event.preventDefault()
      openExternal(url)
    })
  })
}
