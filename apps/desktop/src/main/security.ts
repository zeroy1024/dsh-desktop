/**
 * security.ts — 渲染进程安全基线。
 *
 * dsh webui 只与当前这一代 agent 的 127.0.0.1:<port> 通信：权限默认全拒、
 * 仅按白名单放行剪贴板写入，禁止 window.open、导航只允许该 origin，
 * 其余一律交给系统浏览器。此外对 agent origin 的主文档钉一层 CSP，
 * 收敛渲染进程被注入时的爆炸半径。
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

/**
 * 钉给 agent 主文档的 CSP。
 *
 * script-src 不得不放行 'unsafe-eval'：上游发布产物
 * （apps/web/dist/assets/index-*.js）内嵌 cordis ModuleLoader 的 __jsExpr
 * 求值路径（`new Function("ctx","expr", with(ctx){ return eval(expr) })`），
 * 任何带 __jsExpr 的配置值都会走到它，无法证明是冷路径，只能保守放行。
 *
 * 还不得不放行 'unsafe-inline'：上游 client-modules 的 bootInjections 会向
 * 主文档注入两个 parser-blocking 的 inline `<script>`——`__ModuleLoader__`
 * queue facade 与 `globalThis.__DSH_BOOT__` 图全局（宿主 webserver 的
 * IndexInjection 机制，见 upstream/packages/client/modules/src/index.ts）。
 * 这两个注入点没有 nonce/hash 协同通道（响应头在 Electron onHeadersReceived
 * 静态下发），不放行 inline 则 WebUI 直接挂载失败（2026-09-04 实测：
 * "web boot: window.__ModuleLoader__ bootstrap facade is missing"）。
 * 其余指令按最小化收敛：禁 object/base/form/frame-ancestors，连接限同源
 * （dsh webui 无 WebSocket，SSE/fetch 均走 127.0.0.1:<port> 同源）。
 */
export const AGENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * 该响应是否需要钉 CSP：仅当前 agent origin 的主文档，其余（静态资源、
 * 非 agent 来源、agent 未就绪）一律不动。纯函数，便于单测。
 */
export function agentDocumentCsp(resourceType: string, url: string, port: number | null): string | null {
  if (resourceType !== 'mainFrame' || port === null) return null
  return isAgentRendererUrl(url, port) ? AGENT_CSP : null
}

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

  // 只给 agent 主文档补 CSP 响应头；dsh 服务端自身不下发 CSP。
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = agentDocumentCsp(details.resourceType, details.url, getAllowedPort())
    callback({
      responseHeaders: csp === null
        ? details.responseHeaders
        : { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    })
  })

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
