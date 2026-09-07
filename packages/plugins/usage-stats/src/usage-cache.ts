/**
 * usage_stats 缓存域：单会话聚合结果的持久化侧车。
 *
 * 与 archive-manager 的归档时间侧车同一模式（schema 校验、原子写、变更事件
 * 由 dsh 存储层负责）；layout 用 per-record + backup-and-skip——每会话一文档、
 * 记录可丢弃（缓存性质：删了下次全量重扫即可），坏行被后端挪到一旁而非拒绝
 * 打开，与上游 session_projcache 同款取舍。
 *
 * 行内 aggregate 与 aggregator.ts 的 SessionUsageAggregate 结构互逆；唯一
 * 差异是 JSON 边界上 firstActive/lastActive 用 null 承载 undefined。
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionUsageAggregate } from './aggregator.ts'

const bucketsSchema = z.object({
  uncachedInput: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
})

const modelBucketsSchema = bucketsSchema.extend({
  perDay: z.record(z.string(), z.number().int().nonnegative()),
})

const dayBucketsSchema = bucketsSchema.extend({
  turns: z.number().int().nonnegative(),
})

const aggregateSchema = z.object({
  turns: z.number().int().nonnegative(),
  firstActive: z.number().int().nonnegative().nullable(),
  lastActive: z.number().int().nonnegative().nullable(),
  byModel: z.record(z.string(), modelBucketsSchema),
  byDay: z.record(z.string(), dayBucketsSchema),
  unattributed: bucketsSchema,
  unattributedTurns: z.number().int().nonnegative(),
})

/**
 * 折算算法世代。从 exact-or-nothing（deriveTurnTokenUsage）切到与会话底栏
 * 同一套 tokenUsage 投影语义时 bump；v2 排除 fork 继承前缀，并仅按 origin 识别子代理。旧版本行正常读取，
 * 命中检查拒绝复用并重算覆盖，不作为损坏记录备份。
 */
export const USAGE_FOLD_VERSION = 2 as const

/** 缓存行：revision 是持久化层的新鲜度令牌（stat 派生，文件一变即变）。 */
export const cachedUsageRowSchema = z.object({
  algoVersion: z.number().int().nonnegative(),
  revision: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  isSubagent: z.boolean(),
  aggregate: aggregateSchema,
})

export type CachedUsageRow = z.infer<typeof cachedUsageRowSchema>

/** 插件自有持久化域声明（name/table 均满足上游 UNIT_NAME_RE）。 */
export const usageStatsDomainSpec = defineDomain({
  name: 'usage_stats',
  version: 0,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable<string, CachedUsageRow>(cachedUsageRowSchema),
  },
})

/** KvTable 的最小可注入子集（单测以 fake 表驱动；缓存缺席时聚合走纯内存）。 */
export interface UsageTablePort {
  get(key: string): CachedUsageRow | undefined
  entries(): IterableIterator<[string, CachedUsageRow]>
  put(key: string, value: CachedUsageRow): Promise<void>
  delete(key: string): Promise<boolean>
}

/** aggregate → 可序列化缓存行（undefined 时间戳转 null 过 JSON 边界）。 */
export function toCachedRow(input: {
  revision: string
  createdAt: number
  isSubagent: boolean
  aggregate: SessionUsageAggregate
}): CachedUsageRow {
  return {
    algoVersion: USAGE_FOLD_VERSION,
    revision: input.revision,
    createdAt: input.createdAt,
    isSubagent: input.isSubagent,
    aggregate: {
      ...input.aggregate,
      firstActive: input.aggregate.firstActive ?? null,
      lastActive: input.aggregate.lastActive ?? null,
    },
  }
}

/** 缓存行 → 折叠输入视图（null 时间戳还原为 undefined）。 */
export function toRowView(id: string, row: CachedUsageRow): import('./aggregator.ts').SessionUsageRowView {
  return {
    id,
    createdAt: row.createdAt,
    lastActive: row.aggregate.lastActive ?? 0,
    isSubagent: row.isSubagent,
    aggregate: {
      ...row.aggregate,
      firstActive: row.aggregate.firstActive ?? undefined,
      lastActive: row.aggregate.lastActive ?? undefined,
    },
  }
}
