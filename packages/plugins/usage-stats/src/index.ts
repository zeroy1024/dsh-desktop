/**
 * usage-stats 的 node 半。
 *
 * 职责：把跨会话用量汇总挂进 dsh 自带 webServer 的同源只读路由（desktop
 * profile 必含 dsh-web-app，服务必然可用）。数据面读 sessionPersistence 的
 * 落盘事件日志——listSnapshots() 轻量枚举（header + stat 派生 revision，不
 * 加载日志字节），revision 与缓存行不一致才 readFrom() 读取逻辑事件重折；折算与会话
 * 底栏 tokenUsage 投影同一套计费语义（见 aggregator.ts）。聚合结果缓存进
 * 自有 storage domain（usage_stats，per-record 可丢弃派生数据）；域打开
 * 失败只降级为「每次全量重算」，不影响路由；运行期缓存操作失败进入退避
 * 窗口（CACHE_FAILURE_BACKOFF_MS），窗口内同样走全量，避免确定性故障下
 * 每请求重试失败操作 + warn 刷屏。
 *
 * 路由刻意 POST 而非 GET：浏览器对同源 GET fetch 不附带 Origin 头，
 * isSameOrigin 会一律 403（archive-manager 同款注释与威胁模型）。
 */

// Type-only：引入路由契约类型，同时激活相关包对 cordis Context 的 merge
// （ctx.webServer / ctx.sessionPersistence / ctx.storageDomain）。
import { registerHostRoute, type HostRouteContext } from '@dsh-desktop/bridge/host-routes'
import { isSameLoopbackOrigin as isSameOrigin } from '@dsh-desktop/bridge/fs-guard'
import { SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  aggregateSessionEvents, foldSessionRows,
  type SessionUsageRowView, type UsageSummary,
} from './aggregator.ts'
import { USAGE_SUMMARY_PATH } from './shared.ts'
import { toCachedRow, toRowView, usageStatsDomainSpec, USAGE_FOLD_VERSION, type CachedUsageRow, type UsageTablePort } from './usage-cache.ts'

export { USAGE_SUMMARY_PATH } from './shared.ts'
export { aggregateSessionEvents, foldSessionRows } from './aggregator.ts'
export { toCachedRow, toRowView, usageStatsDomainSpec, USAGE_FOLD_VERSION } from './usage-cache.ts'
export type { CachedUsageRow, UsageTablePort } from './usage-cache.ts'
export type { SessionUsageAggregate, SessionUsageRowView, UsageSummary } from './aggregator.ts'

/** Loader-visible plugin identity. */
export const name = 'usage-stats'

/** 依赖服务未就绪时 fiber 保持 PENDING，就绪后自动补跑 apply。 */
export const inject = ['webServer', 'connection', 'sessionPersistence', 'storageDomain']

/** 本插件触碰的持久化服务切片。 */
export type UsagePersistence = Pick<SessionPersistence, 'listSnapshots' | 'readFrom'>

/** apply 的 ctx 形状：注入服务切片（运行时数据由宿主拥有，不 import 上游 src）。 */
export interface UsageStatsHostContext extends HostRouteContext {
  sessionPersistence: UsagePersistence
  storageDomain: DomainFacility
}

/** 汇总的执行元数据（本次请求扫了几个会话、几个命中缓存）。 */
export interface SummaryMeta {
  /** 落盘会话总数。 */
  total: number
  /** 本次实际读日志重折的会话数。 */
  scanned: number
  /** 命中缓存的会话数。 */
  cached: number
  /** 无法读取源日志的会话数；非零表示统计不完整。 */
  failed: number
}

/** 子代理会话：仅依据显式 origin 标记；普通 fork 不是子代理。 */
export function isSubagentHeader(header: Pick<SessionHeader, 'origin'>): boolean {
  return header.origin === 'subagent'
}

/**
 * 跨会话汇总主流程：轻量枚举 → 缓存对齐（删行 + revision 比对）→ 逐会话
 * 重折/命中 → foldSessionRows。单会话读日志失败只降级该会话（console 诊断），
 * 不拖垮整体汇总；list 与 read 之间的删除竞态（NotFound）属良性，静默跳过、
 * 不计 failed；缓存缺席（port undefined）时退化为每次全量重算。
 */
export async function computeSummary(
  persistence: UsagePersistence,
  port: UsageTablePort | undefined,
  nowMs: number,
  /** 缓存操作失败回调：宿主（apply）据此进入退避窗口，窗口内跳过缓存层。 */
  onCacheFailure?: (error: unknown) => void,
): Promise<{ summary: UsageSummary; meta: SummaryMeta }> {
  const snapshots = await persistence.listSnapshots()
  const liveIds = new Set<string>(snapshots.map(snapshot => snapshot.header.id))
  // 缓存失败只禁用本次请求的缓存，并上报宿主进入退避窗口（窗口过后再试）。
  const disableCache = (error: unknown): void => {
    console.warn('usage-stats: cache unavailable; computing without cache:', error)
    port = undefined
    onCacheFailure?.(error)
  }
  try {
    if (port !== undefined) {
      for (const [key] of port.entries()) {
        if (liveIds.has(key)) continue
        // 单条 key 删除失败不中止对其余过期 key 的清扫。
        try {
          await port.delete(key)
        } catch (error) {
          console.warn(`usage-stats: failed to evict stale cache row ${key}:`, error)
        }
      }
    }
  } catch (error) { disableCache(error) }

  const views: SessionUsageRowView[] = []
  let scanned = 0
  let cached = 0
  let failed = 0
  for (const snapshot of snapshots) {
    const id = snapshot.header.id
    let hit: CachedUsageRow | undefined
    try { hit = port?.get(id) } catch (error) { disableCache(error) }
    if (hit !== undefined && hit.revision === snapshot.revision && hit.algoVersion === USAGE_FOLD_VERSION) {
      views.push(toRowView(id, hit))
      cached++
      continue
    }
    scanned++
    try {
      const stored = await persistence.readFrom(id, SessionLogOffset(0))
      // Fork prefixes contain calls already charged to their original session.
      // Keep all own events, including usage hidden by a later rewind.
      const aggregate = aggregateSessionEvents(stored.events.filter(event => event.seq >= stored.inheritedEventCount))
      const row = toCachedRow({
        revision: snapshot.revision,
        createdAt: stored.meta.createdAt,
        isSubagent: isSubagentHeader(stored.meta),
        aggregate,
      })
      views.push(toRowView(id, row))
      try {
        if (port !== undefined) await port.put(id, row)
      } catch (error) { disableCache(error) }
    } catch (error) {
      // list 与 read 之间的删除竞态是良性的：会话已消失，静默跳过，不计 failed。
      if (error instanceof SessionPersistenceNotFoundError) continue
      failed++
      console.error(`usage-stats: failed to aggregate session ${id}:`, error)
    }
  }
  return { summary: foldSessionRows(views, nowMs), meta: { total: snapshots.length, scanned, cached, failed } }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 汇总路由主处理：方法 → 同源 → computeSummary，任何失败都以结构化 JSON
 * 应答，绝不向 webServer 抛异常（响应生命周期完全由本 handler 拥有）。
 * port 以 getter 注入：缓存域异步打开，就绪前请求退化为全量重算；缓存失败
 * 退避窗口内 getter 同样返回 undefined。
 */
export async function handleSummaryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  persistence: UsagePersistence,
  getPort: () => UsageTablePort | undefined,
  onCacheFailure?: (error: unknown) => void,
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
    const generatedAt = Date.now()
    const { summary, meta } = await computeSummary(persistence, getPort(), generatedAt, onCacheFailure)
    sendJson(res, 200, { ok: true, generatedAt, ...meta, summary })
  } catch (error) {
    console.error('usage-stats: summary request failed:', error)
    sendJson(res, 500, { ok: false, code: 'internal-error' })
  }
}

/**
 * 缓存失败退避窗口：确定性故障（磁盘只读、坏记录）下，窗口内路由跳过缓存层
 * 直接全量扫，避免每请求重试失败操作 + console.warn 刷屏；窗口过后再试。
 */
export const CACHE_FAILURE_BACKOFF_MS = 30_000

/**
 * cordis 插件入口：依赖未就绪时本函数不会被调用（cordis 等待语义）。
 * 注册 summary 路由 + 打开缓存域（打开失败只降级，不影响路由）。
 */
export function apply(ctx: UsageStatsHostContext): void {
  let port: UsageTablePort | undefined
  /** 上次缓存操作失败的时间戳（Date.now()）；退避窗口内 getPort 返回 undefined。 */
  let lastCacheFailureAt = Number.NEGATIVE_INFINITY
  registerHostRoute(ctx, {
    kind: 'exact',
    path: USAGE_SUMMARY_PATH,
    handler: (req, res) => handleSummaryRequest(
      req,
      res,
      ctx.sessionPersistence,
      () => (Date.now() - lastCacheFailureAt < CACHE_FAILURE_BACKOFF_MS ? undefined : port),
      () => { lastCacheFailureAt = Date.now() },
    ),
  })

  ctx.effect(async () => {
    try {
      const domain = await ctx.storageDomain.open(usageStatsDomainSpec)
      port = domain.table('sessions')
      return async () => {
        port = undefined
        await domain.close()
      }
    } catch (error) {
      console.error('usage-stats: cache domain failed to open:', error)
      port = undefined
      return () => {}
    }
  }, 'usage-stats: cache domain')
}
