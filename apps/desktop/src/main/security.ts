/**
 * security.ts — 渲染进程安全基线。
 *
 * dsh webui 只需要与 127.0.0.1 上的 agent 通信：拒绝一切权限请求、
 * 禁止 window.open、导航只允许 agent origin，其余一律交给系统浏览器。
 */
import { app, session, shell } from 'electron'

/**
 * 安装全局安全钩子。
 *
 * @param getAllowedOrigin - 返回当前允许的 origin（agent ready 后为
 *   `dsh://127.0.0.1`，未 ready 时为 null，此时拒绝所有导航）。
 */
export function installSecurityHooks(getAllowedOrigin: () => string | null): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      const allowed = getAllowedOrigin()
      if (allowed !== null && url.startsWith(allowed)) return
      event.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    })
  })
}
