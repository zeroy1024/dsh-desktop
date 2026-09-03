/**
 * archive-manager 的 node 半。
 *
 * 上游 dsh 的会话归档是单向操作（详见 docs/adr/0005）：归档仅向 workspace 域
 * `archivedSessionIds` 追加 ID，无恢复 API。本插件把恢复路由挂进 dsh 自带的
 * webServer（desktop profile 必含 dsh-web-app，服务必然可用），客户端半从页面
 * origin 同源访问，无 CORS / 端口协商。
 *
 * 恢复实现调用 `WorkspaceRegistry` 运行时存在的 private `setState`——TS private
 * 仅存在于编译期。走 registry 官方链路意味着内存态、workspace.json 持久化与
 * `domain/changed` → `host/archived-sessions-changed` 广播一次完成，客户端 store
 * 自动消化，侧边栏实时刷新。上游若重构该内部面，路由返回 501 降级（ADR-0005）。
 */

// Type-only：引入路由契约类型，同时激活三个包对 cordis Context 的 merge
// （ctx.webServer / ctx.workspaceRegistry / ctx.storageDomain）；不拉任何 Host 实现。
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { DomainChanged, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TIMESTAMPS_PATH, UNARCHIVE_PATH } from './shared.ts'
import { ArchiveTimestampTracker, archiveTimestampsDomainSpec } from './timestamps.ts'

export { TIMESTAMPS_PATH, UNARCHIVE_PATH } from './shared.ts'
export {
  ArchiveTimestampTracker, archivedIdsOf, archiveTimestampsDomainSpec, archiveTimestampRowSchema,
} from './timestamps.ts'
export type { TimestampTablePort } from './timestamps.ts'

/** Loader-visible plugin identity. */
export const name = 'archive-manager'

/** 三个依赖服务未就绪时 fiber 保持 PENDING，就绪后自动补跑 apply。 */
export const inject = ['webServer', 'workspaceRegistry', 'storageDomain']

/** 请求体上限：单条会话 ID 的请求远用不到这个量级。 */
const MAX_BODY_BYTES = 4096

/** 上游内部面不可用（`state`/`setState` 缺失）时抛出；路由层转为 501。 */
export class UnsupportedRegistryError extends Error {
  constructor() {
    super('WorkspaceRegistry no longer exposes the runtime state/setState surface')
    this.name = 'UnsupportedRegistryError'
  }
}

/**
 * `WorkspaceRegistry` 的运行时内部面。TS `private` 不产生运行时隔离，这里的
 * 形状只是编译期观察工具；上游重构导致任一成员缺失时走 501 降级。
 */
interface RegistryInternals {
  state?: {
    archivedSessionIds?: readonly string[]
    [key: string]: unknown
  }
  setState?: (state: unknown) => Promise<void>
}

/** unarchive 成功结果；`changed` 为 false 表示该会话本就不在归档集合（幂等）。 */
export interface UnarchiveResult {
  archivedSessionIds: readonly string[]
  changed: boolean
}

/**
 * 从归档集合中移除一个会话并经 registry 官方 `setState` 持久化。
 * 写操作串行化在包级 promise 链上：setState 绕过了 registry 的
 * `enqueueOperation` 串行链，用本地互斥弥补与并发归档的写交错窗口。
 */
export function unarchiveSession(
  registry: WorkspaceRegistry | unknown,
  sessionId: string,
): Promise<UnarchiveResult> {
  const internals = registry as RegistryInternals
  if (internals.state === undefined || typeof internals.setState !== 'function') {
    return Promise.reject(new UnsupportedRegistryError())
  }
  const current = internals.state.archivedSessionIds
  if (current === undefined) {
    return Promise.reject(new UnsupportedRegistryError())
  }
  if (!current.includes(sessionId)) {
    return Promise.resolve({ archivedSessionIds: current, changed: false })
  }
  return enqueueWrite(() => {
    // 互斥窗口内重读最新 state，避免覆盖并发写入的其他字段。
    const latest = (registry as RegistryInternals).state
    const archived = latest?.archivedSessionIds
    if (latest === undefined || archived === undefined || typeof internals.setState !== 'function') {
      return Promise.reject(new UnsupportedRegistryError())
    }
    if (!archived.includes(sessionId)) {
      return Promise.resolve({ archivedSessionIds: archived, changed: false })
    }
    const next = { ...latest, archivedSessionIds: archived.filter(id => id !== sessionId) }
    return internals.setState.call(registry, next).then(
      () => ({ archivedSessionIds: next.archivedSessionIds, changed: true }),
    )
  })
}

/** 包级写互斥链：前序写失败不阻断后续请求，但每次写都基于重读的 state。 */
let writeTail: Promise<unknown> = Promise.resolve()
function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeTail.then(operation, operation)
  writeTail = run.then(() => {}, () => {})
  return run
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
 * 逻辑镜像 packages/bridge/src/origin.ts 的判定思路；不 import 是因为
 * staged 插件闭包解析不到 workspace 内部包，十几行内联不值得引入装配复杂度。
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

/** 会话 ID 里不允许出现的 C0/C1 控制字符与 DEL。 */
function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** 会话 ID 形如 `session-<uuid>`；这里只做传输层校验，语义交给 registry。 */
function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && !hasControlChar(value)
}

/**
 * 路由主处理：方法 → 同源 → 载荷 → unarchive，任何失败都以结构化 JSON 应答，
 * 绝不向 webServer 抛异常（响应生命周期完全由本 handler 拥有）。
 */
export async function handleUnarchiveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: WorkspaceRegistry | unknown,
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
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
    if (!isValidSessionId(sessionId)) {
      sendJson(res, 400, { ok: false, code: 'invalid-session-id' })
      return
    }
    const result = await unarchiveSession(registry, sessionId)
    sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    if (error instanceof UnsupportedRegistryError) {
      sendJson(res, 501, { ok: false, code: 'unsupported-host' })
      return
    }
    sendJson(res, 500, { ok: false, code: 'internal-error' })
  }
}

/** 把恢复路由注册进 webServer；返回 disposer 交给 ctx.effect 管理生命周期。 */
export function registerUnarchiveRoute(webServer: WebServer, registry: WorkspaceRegistry): () => void {
  return webServer.register({
    kind: 'exact',
    path: UNARCHIVE_PATH,
    handler: (req, res) => { void handleUnarchiveRequest(req, res, registry) },
  })
}

/**
 * 归档时间查询路由：POST + 同源校验（与 unarchive 同一威胁模型——路由虽只读，
 * 跨站探测本机归档集合同样不应得逞）。方法刻意用 POST 而非 GET：浏览器对
 * 同源 GET fetch 不附带 Origin 头，isSameOrigin 会一律 403；POST 恒带 Origin，
 * 判定面与 unarchive 完全同构。载荷是 `{ ok, timestamps }`，读取失败回 500。
 */
export async function handleTimestampsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  tracker: { read(): Promise<Record<string, number>> },
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
    const timestamps = await tracker.read()
    sendJson(res, 200, { ok: true, timestamps })
  } catch {
    sendJson(res, 500, { ok: false, code: 'internal-error' })
  }
}

/** 把时间戳路由注册进 webServer；返回 disposer。 */
export function registerTimestampsRoute(
  webServer: WebServer,
  tracker: { read(): Promise<Record<string, number>> },
): () => void {
  return webServer.register({
    kind: 'exact',
    path: TIMESTAMPS_PATH,
    handler: (req, res) => { void handleTimestampsRequest(req, res, tracker) },
  })
}

/** apply 的 ctx 形状：三个注入服务 + effect/on（类型面取注入契约）。 */
export interface ArchiveManagerHostContext {
  effect: (factory: () => (() => void) | Promise<() => void>, name?: string) => unknown
  on: (name: string, listener: (change: DomainChanged) => void) => unknown
  webServer: WebServer
  workspaceRegistry: WorkspaceRegistry
  storageDomain: DomainFacility
}

/**
 * cordis 插件入口：依赖未就绪时本函数不会被调用（cordis 等待语义）。
 *
 * 装配三件事：
 * 1. unarchive 路由（原有）；
 * 2. timestamps 查询路由（新增，读侧车快照）；
 * 3. 时间侧车：`domain/changed` 监听器同步注册（observe 在 attach 前是空操作），
 *    打开 `archive_timestamps` 域后 seed 并 attach。域打开失败（上游存储故障
 *    等）只降级为「无归档时间」，不影响恢复路由——effect 工厂 catch 后返回
 *    空 disposer。
 */
export function apply(ctx: ArchiveManagerHostContext): void {
  ctx.effect(
    () => registerUnarchiveRoute(ctx.webServer, ctx.workspaceRegistry),
    'archive-manager: unarchive route',
  )

  const tracker = new ArchiveTimestampTracker()
  ctx.effect(
    () => registerTimestampsRoute(ctx.webServer, tracker),
    'archive-manager: timestamps route',
  )

  ctx.on('domain/changed', change => tracker.observe(change))
  ctx.effect(async () => {
    try {
      const domain = await ctx.storageDomain.open(archiveTimestampsDomainSpec)
      tracker.attach(domain.table('sessions'), ctx.workspaceRegistry.archivedSessionIds)
      return async () => {
        // detach 后不再接受新 reconcile；在途写排空后才关域。
        tracker.detach()
        await tracker.flush()
        await domain.close()
      }
    } catch (error) {
      console.error('archive-manager: timestamps domain failed to open:', error)
      return () => {}
    }
  }, 'archive-manager: timestamps domain')
}
