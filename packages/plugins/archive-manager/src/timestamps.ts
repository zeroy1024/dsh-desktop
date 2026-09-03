/**
 * 归档时间侧车。
 *
 * 上游的归档集合 `archivedSessionIds` 只是 ID 数组、不携带时间戳（workspace 域
 * spec 的既有形状），所以「归档时间」必须由本插件自己记录。持久化走 storage
 * domain 侧车表（session id → 归档时刻），与官方 message-feedback 的 sidecar
 * domain 同一模式：schema 校验、原子写、变更事件全部由 dsh 存储层负责。
 *
 * 数据来源是 `domain/changed` 事件：workspace 域 global 的每次写入都携带完整
 * 新快照（storage-domain 的既有契约，上游 apiproxy 同样消费），插件无需修改
 * 上游即可观测归档/恢复动作。处理策略是「快照 reconcile」而非增量 diff：每次
 * 事件把侧车表与快照对齐（缺失则记 now、多余则删），因此天然幂等、容忍事件
 * 丢失或乱序；domain 打开前到达的事件直接丢弃，打开时以 registry 当前集合
 * seed 一次（单线程 JS 下 attach+seed 之间不可能插入事件，语义等价）。
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'

/** 侧车行：一个会话的归档时刻（epoch 毫秒）。 */
export const archiveTimestampRowSchema = z.object({
  archivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

export type ArchiveTimestampRow = z.infer<typeof archiveTimestampRowSchema>

/** 插件自有持久化域声明（name/table 均满足上游 UNIT_NAME_RE）。 */
export const archiveTimestampsDomainSpec = defineDomain({
  name: 'archive_timestamps',
  version: 0,
  tables: {
    sessions: domainTable<string, ArchiveTimestampRow>(archiveTimestampRowSchema),
  },
})

/** KvTable 的最小可注入子集（单测以 fake 表驱动）。 */
export interface TimestampTablePort {
  get(key: string): ArchiveTimestampRow | undefined
  entries(): IterableIterator<[string, ArchiveTimestampRow]>
  put(key: string, value: ArchiveTimestampRow): Promise<void>
  delete(key: string): Promise<boolean>
}

/**
 * 从 `domain/changed` 提取 workspace 归档快照。非 workspace global 写入、
 * 或删除事件、或载荷形状不符时返回 undefined（调用方忽略该事件）。
 */
export function archivedIdsOf(change: DomainChanged): readonly string[] | undefined {
  if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return undefined
  const ids = (change.value as { archivedSessionIds?: unknown } | null | undefined)?.archivedSessionIds
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return undefined
  return ids as string[]
}

/**
 * 侧车表的生命周期持有者：attach 前 observe 为空操作，attach 后每次 reconcile
 * 串行写在自己的 promise 链上（与 index.ts 的写互斥同一手法），read 排在链尾，
 * 保证读到最新已落盘的快照。写失败只记 console 诊断，不阻断后续事件。
 */
export class ArchiveTimestampTracker {
  private port: TimestampTablePort | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly onError: (error: unknown) => void =
      error => console.error('archive-manager: timestamp reconcile failed:', error),
  ) {}

  /** 接管侧车表并以当前归档集合 seed（缺失的 ID 记 seed 时刻）。 */
  attach(port: TimestampTablePort, seed: readonly string[]): void {
    this.port = port
    this.reconcile(seed)
  }

  /** 释放表句柄（domain 关闭时调用）；在途写由 disposer 先行 await。 */
  detach(): void {
    this.port = undefined
  }

  /** `domain/changed` 入口；与归档快照无关的事件被忽略。 */
  observe(change: DomainChanged): void {
    const ids = archivedIdsOf(change)
    if (ids !== undefined) this.reconcile(ids)
  }

  /** 当前侧车快照；等待在途写链后读取。未 attach 时为空对象。 */
  read(): Promise<Record<string, number>> {
    const port = this.port
    if (port === undefined) return Promise.resolve({})
    return this.flush().then(() => {
      const snapshot: Record<string, number> = {}
      for (const [key, row] of port.entries()) snapshot[key] = row.archivedAt
      return snapshot
    })
  }

  /** 排空在途写链（失败也视为排空，chain 本身经 onError 永不自拒）。 */
  flush(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  /** 把侧车表对齐到归档快照：多余删、缺失补（记 now）。 */
  private reconcile(ids: readonly string[]): void {
    const port = this.port
    if (port === undefined) return
    const target = new Set(ids)
    const now = this.now()
    const job = async (): Promise<void> => {
      // Array.from 先物化键快照：真实 KvTable 的 entries 本就是快照，但 fake
      // 表是活 Map 迭代器，异步 job 里的 delete 不能边删边迭代。
      for (const stale of Array.from(port.entries(), ([id]) => id)) {
        if (!target.has(stale)) await port.delete(stale)
      }
      for (const id of target) {
        if (port.get(id) === undefined) await port.put(id, { archivedAt: now })
      }
    }
    // 前序写失败不阻断本次 reconcile（then 双分支同 job）；本环错误记一次。
    const run = this.chain.then(job, job)
    this.chain = run.then(() => {}, this.onError)
  }
}
