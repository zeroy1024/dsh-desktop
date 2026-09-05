/**
 * archive-manager 的 node 半。
 *
 * 本插件通过 WorkspaceRegistry 公开的 unarchiveSession 取消归档（详见
 * docs/adr/0005），把恢复路由挂进 dsh 自带的
 * webServer（desktop profile 必含 dsh-web-app，服务必然可用），客户端半从页面
 * origin 同源访问，无 CORS / 端口协商。
 *
 * registry 拥有写入队列、持久化与变更广播；插件不访问其内部状态或存储。
 * 公共 API 缺席时返回 501，客户端保留只读列表。
 */

// Type-only：引入路由契约类型，同时激活三个包对 cordis Context 的 merge
// （ctx.webServer / ctx.workspaceRegistry / ctx.storageDomain）；不拉任何 Host 实现。
import { registerHostRoute, type HostRouteContext } from '@dsh-desktop/bridge/host-routes'
import { isSameLoopbackOrigin as isSameOrigin } from '@dsh-desktop/bridge/fs-guard'
export { isSameLoopbackOrigin as isSameOrigin } from '@dsh-desktop/bridge/fs-guard'
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
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'storageDomain']

/** 请求体上限：单条会话 ID 的请求远用不到这个量级。 */
const MAX_BODY_BYTES = 4096

/** 宿主缺少取消归档公共 API 时抛出；路由层转为 501。 */
export class UnsupportedRegistryError extends Error {
  constructor() {
    super('WorkspaceRegistry does not provide the public unarchiveSession API')
    this.name = 'UnsupportedRegistryError'
  }
}

/** Narrow public host contract; its method signature comes from the vendored package. */
export type UnarchiveRegistry = Pick<WorkspaceRegistry, 'unarchiveSession' | 'archivedSessionIds'>

/** unarchive 成功结果；`changed` 为 false 表示该会话本就不在归档集合（幂等）。 */
export interface UnarchiveResult {
  archivedSessionIds: readonly string[]
  changed: boolean
}

/** 与上游归档、工作区操作共用同一队列，避免读改写覆盖其他操作。 */
export async function unarchiveSession(
  registry: UnarchiveRegistry,
  sessionId: string,
): Promise<UnarchiveResult> {
  if (typeof registry.unarchiveSession !== 'function') throw new UnsupportedRegistryError()
  const changed = await registry.unarchiveSession(sessionId as WorkspaceRegistry['archivedSessionIds'][number])
  return { changed, archivedSessionIds: registry.archivedSessionIds }
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
  registry: UnarchiveRegistry,
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

/** 把恢复路由注册进 webServer；鉴权与 disposer 由 registerHostRoute 绑定插件生命周期。 */
export function registerUnarchiveRoute(ctx: HostRouteContext, registry: WorkspaceRegistry): () => Promise<void> {
  return registerHostRoute(ctx, {
    kind: 'exact',
    path: UNARCHIVE_PATH,
    handler: (req, res) => handleUnarchiveRequest(req, res, registry),
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
  ctx: HostRouteContext,
  tracker: { read(): Promise<Record<string, number>> },
): () => Promise<void> {
  return registerHostRoute(ctx, {
    kind: 'exact',
    path: TIMESTAMPS_PATH,
    handler: (req, res) => handleTimestampsRequest(req, res, tracker),
  })
}

/** apply 的 ctx 形状：三个注入服务 + effect/on（类型面取注入契约）。 */
export interface ArchiveManagerHostContext extends HostRouteContext {
  on: (name: string, listener: (change: DomainChanged) => void) => unknown
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
  registerUnarchiveRoute(ctx, ctx.workspaceRegistry)

  const tracker = new ArchiveTimestampTracker()
  registerTimestampsRoute(ctx, tracker)

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
