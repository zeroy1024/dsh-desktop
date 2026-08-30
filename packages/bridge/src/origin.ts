/**
 * 渲染进程只允许打开当前这一代 agent 的 loopback HTTP origin。
 *
 * 页面 URL 是 `http://127.0.0.1:<port>/`，不含 launch token。
 * 当前上游 ready 行已无 token（Host/Origin trust fence）；token 若再现，
 * 留在主进程，不进文档 URL，也不为此恢复自定义协议。
 */

export const AGENT_HOST = '127.0.0.1'

function assertAgentPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`bridge: invalid agent port ${String(port)}`)
  }
}

/** `http://127.0.0.1:<port>`（无尾斜杠）。 */
export function agentOrigin(port: number): string {
  assertAgentPort(port)
  return `http://${AGENT_HOST}:${String(port)}`
}

/** 给 loadURL 用的文档地址，永不带 query。 */
export function agentPageUrl(port: number): string {
  return `${agentOrigin(port)}/`
}

/**
 * 是否为这一代 agent 的渲染 origin。
 * 允许任意 path/search/hash；拒绝凭据、非 http、非 127.0.0.1、端口不符。
 */
export function isAgentRendererUrl(value: string, port: number): boolean {
  try {
    const url = new URL(value)
    const expected = new URL(agentOrigin(port))
    return url.protocol === expected.protocol
      && url.hostname === expected.hostname
      && url.port === expected.port
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}
