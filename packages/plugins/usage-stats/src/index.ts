/**
 * usage-stats 的 node 半。
 *
 * 职责：把跨会话用量汇总挂进 dsh 自带 webServer 的同源只读路由（desktop
 * profile 必含 dsh-web-app，服务必然可用）。数据面读 sessionPersistence 的
 * 落盘事件日志——listSnapshots() 轻量枚举（header + stat 派生 revision，不
 * 加载日志字节），revision 与缓存行不一致才 readRaw() 全文重折；折算与会话
 * 底栏 tokenUsage 投影同一套计费语义（见 aggregator.ts）。聚合结果缓存进
 * 自有 storage domain（usage_stats，per-record 可丢弃派生数据）；域打开
 * 失败只降级为「每次全量重算」，不影响路由。
 *
 * 路由刻意 POST 而非 GET：浏览器对同源 GET fetch 不附带 Origin 头，
 * isSameOrigin 会一律 403（archive-manager 同款注释与威胁模型）。
 */

// Type-only：引入路由契约类型，同时激活相关包对 cordis Context 的 merge
// （ctx.webServer / ctx.sessionPersistence / ctx.storageDomain）；不拉任何 Host 实现。
import { registerHostRoute, type HostRouteContext } from '@dsh-desktop/bridge/host-routes'
import { isSameLoopbackOrigin as isSameOrigin } from '@dsh-desktop/bridge/fs-guard'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
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
export type UsagePersistence = Pick<SessionPersistence, 'listSnapshots' | 'readRaw'>

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
}

/** 子代理会话：显式 origin 标记或带 fork 父会话。 */
export function isSubagentHeader(header: Pick<SessionHeader, 'origin' | 'parentSession'>): boolean {
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/**
 * 解码 JSONL 原文为事件数组。首行是 header record（无 type 字段）天然被
 * 过滤；截断/损坏行跳过——append-only 日志只有尾行可能截断，且持久化层
 * readRaw 已做过帧级完整性校验，这里只是纵深防御。
 */
export function parseSessionLog(content: string): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        events.push(parsed as SessionEvent)
      }
    } catch {
      // 损坏行：跳过。
    }
  }
  return events
}

/**
 * 跨会话汇总主流程：轻量枚举 → 缓存对齐（删行 + revision 比对）→ 逐会话
 * 重折/命中 → foldSessionRows。单会话读日志失败只降级该会话（console 诊断），
 * 不拖垮整体汇总；缓存缺席（port undefined）时退化为每次全量重算。
 */
export async function computeSummary(
  persistence: UsagePersistence,
  port: UsageTablePort | undefined,
  nowMs: number,
): Promise<{ summary: UsageSummary; meta: SummaryMeta }> {
  const snapshots = await persistence.listSnapshots()
  const liveIds = new Set<string>(snapshots.map(snapshot => snapshot.header.id))
  if (port !== undefined) {
    for (const [key] of port.entries()) {
      if (!liveIds.has(key)) await port.delete(key)
    }
  }

  const views: SessionUsageRowView[] = []
  let scanned = 0
  let cached = 0
  for (const snapshot of snapshots) {
    const id = snapshot.header.id
    const hit: CachedUsageRow | undefined = port?.get(id)
    if (hit !== undefined && hit.revision === snapshot.revision && hit.algoVersion === USAGE_FOLD_VERSION) {
      views.push(toRowView(id, hit))
      cached++
      continue
    }
    scanned++
    try {
      const raw = await persistence.readRaw(id)
      // 后端不支持 raw 工件（理论上 jsonl 支持）或会话刚好消失：跳过且不入缓存。
      if (raw === undefined) continue
      const aggregate = aggregateSessionEvents(parseSessionLog(raw.content))
      const row = toCachedRow({
        revision: snapshot.revision,
        createdAt: snapshot.header.createdAt,
        isSubagent: isSubagentHeader(snapshot.header),
        aggregate,
      })
      if (port !== undefined) await port.put(id, row)
      views.push(toRowView(id, row))
    } catch (error) {
      console.error(`usage-stats: failed to aggregate session ${id}:`, error)
    }
  }
  return { summary: foldSessionRows(views, nowMs), meta: { total: snapshots.length, scanned, cached } }
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
 * port 以 getter 注入：缓存域异步打开，就绪前请求退化为全量重算。
 */
export async function handleSummaryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  persistence: UsagePersistence,
  getPort: () => UsageTablePort | undefined,
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
    const { summary, meta } = await computeSummary(persistence, getPort(), generatedAt)
    sendJson(res, 200, { ok: true, generatedAt, ...meta, summary })
  } catch (error) {
    console.error('usage-stats: summary request failed:', error)
    sendJson(res, 500, { ok: false, code: 'internal-error' })
  }
}

/**
 * cordis 插件入口：依赖未就绪时本函数不会被调用（cordis 等待语义）。
 * 注册 summary 路由 + 打开缓存域（打开失败只降级，不影响路由）。
 */
export function apply(ctx: UsageStatsHostContext): void {
  let port: UsageTablePort | undefined
  registerHostRoute(ctx, {
    kind: 'exact',
    path: USAGE_SUMMARY_PATH,
    handler: (req, res) => handleSummaryRequest(req, res, ctx.sessionPersistence, () => port),
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
