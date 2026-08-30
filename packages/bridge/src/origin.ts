/**
 * dsh:// 自定义协议与 agent HTTP 的映射。
 *
 * 渲染进程 origin 用 `dsh://127.0.0.1`，这样官方 `isLoopbackHostname` 仍为 true
 * （原生目录选择等桌面能力依赖它）。主进程把请求转到
 * `http://127.0.0.1:<port>`，并剥掉 Origin / Fetch-Metadata，避免 agent 的
 * /api trust fence 把 dsh:// Origin 当成跨站 403。
 */

export const DSH_SCHEME = 'dsh'
export const DSH_HOST = '127.0.0.1'
export const DSH_ORIGIN = `${DSH_SCHEME}://${DSH_HOST}`

/** 浏览器会带上、但转发给 loopback agent 时必须丢掉的头。 */
export const STRIP_WHEN_PROXYING = [
  'origin',
  'referer',
  'referrer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-purpose',
] as const

export interface AgentEndpoint {
  port: number
  token: string | null
}

/**
 * 把 dsh:// 请求映射成 agent HTTP URL。
 * @throws 非本协议或 host 不是 loopback。
 */
export function toAgentHttpUrl(requestUrl: string, agent: AgentEndpoint): string {
  const src = new URL(requestUrl)
  if (src.protocol !== `${DSH_SCHEME}:` || src.hostname !== DSH_HOST) {
    throw new Error(`bridge: refused to proxy ${requestUrl}`)
  }
  const dest = new URL(`http://${DSH_HOST}:${String(agent.port)}${src.pathname}${src.search}`)
  if (agent.token !== null && !dest.searchParams.has('token')) {
    dest.searchParams.set('token', agent.token)
  }
  return dest.toString()
}

/** agent WebSocket 地址（主进程连）。 */
export function toAgentWsUrl(pathnameAndSearch: string, agent: AgentEndpoint): string {
  const dest = new URL(`http://${DSH_HOST}:${String(agent.port)}${pathnameAndSearch}`)
  dest.protocol = 'ws:'
  if (agent.token !== null && !dest.searchParams.has('token')) {
    dest.searchParams.set('token', agent.token)
  }
  return dest.toString()
}

/** 复制 Headers 并去掉浏览器跨站标记。 */
export function headersForAgent(input: Headers): Headers {
  const out = new Headers()
  for (const [key, value] of input.entries()) {
    if ((STRIP_WHEN_PROXYING as readonly string[]).includes(key.toLowerCase())) continue
    out.append(key, value)
  }
  return out
}

/** 是否应把 WebSocket 从页面拦到 IPC（mux/host 下行）。 */
export function isAgentEventSocket(pathname: string): boolean {
  return pathname === '/api/events.mux' || pathname === '/api/events.host'
}
