/**
 * protocol.ts — dsh:// 自定义协议，把渲染进程的文档/脚本/fetch 转到 agent HTTP。
 *
 * registerSchemesAsPrivileged 必须在 app.whenReady 之前调用。
 * 页面 origin 是 dsh://127.0.0.1，token 只出现在主进程发出的 URL 上。
 */
import { net, protocol } from 'electron'
import {
  DSH_ORIGIN,
  DSH_SCHEME,
  headersForAgent,
  injectWsShim,
  toAgentHttpUrl,
  type AgentEndpoint,
} from '@dsh-desktop/bridge'

let agent: AgentEndpoint | null = null

export function setAgentEndpoint(next: AgentEndpoint | null): void {
  agent = next
}

export function getAgentEndpoint(): AgentEndpoint | null {
  return agent
}

/** 必须在 app.whenReady 之前。 */
export function registerDshScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DSH_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/** 在 session 可用后安装 handler（whenReady 之后）。 */
export function installDshProtocolHandler(): void {
  protocol.handle(DSH_SCHEME, async (request) => {
    if (agent === null) {
      return new Response('agent not ready', { status: 503 })
    }
    const target = toAgentHttpUrl(request.url, agent)
    const headers = headersForAgent(request.headers)
    const init: RequestInit = {
      method: request.method,
      headers,
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null) {
      init.body = request.body
      Object.assign(init, { duplex: 'half' })
    }
    const response = await net.fetch(target, {
      ...init,
      bypassCustomProtocolHandlers: true,
    } as RequestInit)
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/html')) {
      const html = injectWsShim(await response.text())
      const outHeaders = new Headers(response.headers)
      outHeaders.delete('content-length')
      return new Response(html, { status: response.status, headers: outHeaders })
    }
    return response
  })
}

export function dshAppUrl(): string {
  return `${DSH_ORIGIN}/`
}
