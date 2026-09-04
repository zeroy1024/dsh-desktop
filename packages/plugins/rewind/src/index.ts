/**
 * rewind 的 node 半：把撤回执行路由挂进 dsh 自带 webServer（同源访问），
 * precheck 后向 live Session 追加 'dsh-desktop/session-rewind' 墓碑事件
 * （patches/0012 的 core surface fold 与 patches/0013 的 client 视图折叠
 * 统一解释，见 docs/adr/0007）。append 同步且自动走官方持久化与
 * session/event 广播链路——本插件不碰任何存储。
 */

import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { REWIND_EVENT_TYPE, REWIND_EXECUTE_PATH } from './shared.ts'

export { REWIND_EVENT_TYPE, REWIND_EXECUTE_PATH } from './shared.ts'

/** Loader-visible plugin identity. */
export const name = 'rewind'

/** 依赖未就绪时 fiber 保持 PENDING，就绪后自动补跑 apply。 */
export const inject = ['webServer', 'sessions', 'agents']

/** 请求体上限：sessionId + atSeq 远用不到这个量级。 */
const MAX_BODY_BYTES = 4096

/** v1 只允许撤回 live 会话（ADR-0007 决定 6）。 */
export type RewindErrorCode =
  | 'not-live'
  | 'agent-running'
  | 'compaction-boundary'
  | 'invalid-at-seq'

/** 本插件触及的 agents 服务面（运行状态检查）。 */
interface AgentsRuntime {
  get(id: string): { status: string } | undefined
}

/** 本插件触及的 sessions 服务面（live 会话表）。 */
interface SessionsRuntime {
  get(id: string): Session | undefined
}

/**
 * 撤回边界 precheck：atSeq 必须指向一条 user/message 事件的 seq，且撤回
 * 区间不得跨越 compaction 替换段——一个替换事件 R（surfaceOp replace）若
 * 起点在 atSeq 之前而自身落在区间内，墓碑的 [atSeq, ∞∩nodes) 截断会把
 * 替换节点连同它覆盖的更早历史一起抹掉（过度回退）。
 */
export function precheckRewind(
  events: readonly SessionEvent[],
  atSeq: unknown,
): RewindErrorCode | undefined {
  if (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0) {
    return 'invalid-at-seq'
  }
  const target = events.find(event => event.seq === atSeq)
  if (target === undefined || target.type !== 'user/message') {
    return 'invalid-at-seq'
  }
  for (const event of events) {
    const op = (event as SessionEvent & { surfaceOp?: unknown }).surfaceOp
    if (op === null || typeof op !== 'object' || !('start' in (op as object))) continue
    if (event.seq >= atSeq && (op as { start: number }).start < atSeq) {
      return 'compaction-boundary'
    }
  }
  return undefined
}

/** Host 头的主机部分必须是 loopback 字面量（webServer 只绑 loopback 的镜像校验）。 */
function isLoopbackHostHeader(hostHeader: string): boolean {
  const portMatch = hostHeader.match(/^(.*):\d+$/u)
  const hostname = portMatch?.[1] ?? hostHeader
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/**
 * 同源判定：Origin 与 Host 头必须指向同一 http(s) 主机与端口，且 Host 的
 * 主机部分是 loopback（防 DNS rebinding：攻击域解析到 127.0.0.1 时 Origin
 * 与 Host 同为攻击域，单纯相等比对放行，loopback 白名单把它拒掉）。
 * 逻辑镜像 packages/bridge/src/origin.ts（staged 闭包解析不到 workspace 包，内联）。
 */
export function isSameOrigin(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (originHeader === undefined || hostHeader === undefined) return false
  let origin: URL
  try {
    origin = new URL(originHeader)
  } catch {
    return false
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
  if (origin.username !== '' || origin.password !== '') return false
  if (!isLoopbackHostHeader(hostHeader)) return false
  return origin.host === hostHeader
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('payload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 路由主处理：方法 → 同源 → 载荷 → live/运行/边界 precheck → 追加墓碑。
 * Session.append 同步且原子（仅防监听器重入），无需插件侧互斥。
 */
export async function handleRewindRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionsRuntime,
  agents: AgentsRuntime,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
      return
    }
    if (!isSameOrigin(req.headers.origin, req.headers.host)) {
      sendJson(res, 403, { ok: false, code: 'cross-origin' })
      return
    }
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, code: 'unsupported-media-type' })
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(await readBody(req)) as unknown
    } catch {
      sendJson(res, 400, { ok: false, code: 'invalid-json' })
      return
    }
    const { sessionId, atSeq } = (payload ?? {}) as { sessionId?: unknown; atSeq?: unknown }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
      sendJson(res, 400, { ok: false, code: 'invalid-session-id' })
      return
    }

    const session = sessions.get(sessionId)
    if (session === undefined) {
      sendJson(res, 409, { ok: false, code: 'not-live' })
      return
    }
    if (agents.get(sessionId)?.status === 'running') {
      sendJson(res, 409, { ok: false, code: 'agent-running' })
      return
    }
    // 0.1.2 迁移期：0012 暂摘后 vendor 内上游类型无 Session.events/墓碑事件名；
    // 阶段 7 重做 0012 后这两个 @ts-expect-error 会因「未使用」报错，届时移除。
    // @ts-expect-error 0012 暂摘期临时放行（阶段 7 恢复）
    const precheckError = precheckRewind(session.events, atSeq)
    if (precheckError !== undefined) {
      sendJson(res, precheckError === 'invalid-at-seq' ? 400 : 409, { ok: false, code: precheckError })
      return
    }

    // @ts-expect-error 0012 暂摘期临时放行（阶段 7 恢复）
    session.append(REWIND_EVENT_TYPE, { atSeq: atSeq as number })
    sendJson(res, 200, { ok: true, atSeq: atSeq as number })
  } catch {
    sendJson(res, 500, { ok: false, code: 'internal-error' })
  }
}

/** 把撤回路由注册进 webServer；disposer 交给 ctx.effect 管理生命周期。 */
export function registerRewindRoute(
  webServer: WebServer,
  sessions: SessionsRuntime,
  agents: AgentsRuntime,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: REWIND_EXECUTE_PATH,
    handler: (req, res) => { void handleRewindRequest(req, res, sessions, agents) },
  })
}

/** cordis 插件入口。 */
export function apply(ctx: {
  effect: (factory: () => void | (() => void), name?: string) => unknown
  webServer: WebServer
  sessions: SessionsRuntime
  agents: AgentsRuntime
}): void {
  ctx.effect(
    () => registerRewindRoute(ctx.webServer, ctx.sessions, ctx.agents),
    'rewind: execute route',
  )
}
