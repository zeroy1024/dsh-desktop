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

/** 只接受应用自己的固定 custom-scheme origin，不做字符串前缀判断。 */
export function isDshRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === `${DSH_SCHEME}:`
      && url.hostname === DSH_HOST
      && url.port === ''
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

function assertAgentEndpoint(agent: AgentEndpoint): void {
  if (!Number.isInteger(agent.port) || agent.port < 1 || agent.port > 65_535) {
    throw new Error(`bridge: invalid agent port ${String(agent.port)}`)
  }
  if (agent.token !== null && typeof agent.token !== 'string') {
    throw new Error('bridge: invalid agent token')
  }
}

/**
 * 把 dsh:// 请求映射成 agent HTTP URL。
 * @throws 非本协议或 host 不是 loopback。
 */
export function toAgentHttpUrl(requestUrl: string, agent: AgentEndpoint): string {
  const src = new URL(requestUrl)
  if (!isDshRendererUrl(src.toString())) {
    throw new Error(`bridge: refused to proxy ${requestUrl}`)
  }
  assertAgentEndpoint(agent)
  const dest = new URL(`http://${DSH_HOST}:${String(agent.port)}${src.pathname}${src.search}`)
  if (agent.token !== null) dest.searchParams.set('token', agent.token)
  return dest.toString()
}

/** agent WebSocket 地址（主进程连）。 */
export function toAgentWsUrl(pathnameAndSearch: string, agent: AgentEndpoint): string {
  const safePath = parseAgentEventPath(pathnameAndSearch)
  if (safePath === null) throw new Error(`bridge: refused WebSocket path ${pathnameAndSearch}`)
  assertAgentEndpoint(agent)
  const dest = new URL(`http://${DSH_HOST}:${String(agent.port)}${safePath}`)
  dest.protocol = 'ws:'
  if (agent.token !== null) dest.searchParams.set('token', agent.token)
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

/** 校验来自 renderer IPC 的 WS 路径并返回规范化 pathname+search。 */
export function parseAgentEventPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  try {
    const url = new URL(value, `${DSH_ORIGIN}/`)
    if (!isDshRendererUrl(url.toString()) || url.hash !== '' || !isAgentEventSocket(url.pathname)) {
      return null
    }
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}
