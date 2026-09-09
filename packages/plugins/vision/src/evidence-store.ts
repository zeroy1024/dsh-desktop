/** Plugin-owned, bounded derived evidence. Original attachments remain authoritative. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_EVIDENCE_CHARS, stableDigest, visionAborted } from './core.ts'

const rowSchema = z.object({
  sessionId: z.string(), attachmentId: z.string(), configVersion: z.string(),
  category: z.enum(['general', 'question', 'immediate']), question: z.string().optional(),
  text: z.string().min(1).max(MAX_EVIDENCE_CHARS), createdAt: z.number(), lastUsedAt: z.number(),
})
export type EvidenceRow = z.infer<typeof rowSchema>
export const evidenceDomain = defineDomain({
  name: 'vision_evidence', version: 0,
  // per-record keeps every put a single-record write; the default single layout
  // would rewrite and fsync the whole domain JSON on every evidence write.
  // Individual invalid records can be discarded without failing the complete domain.
  layout: 'per-record',
  tables: { evidence: domainTable<string, unknown>(z.unknown()) },
})
interface Table {
  get(key: string): unknown
  entries(): IterableIterator<[string, unknown]>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}
interface StoreContext {
  get(name: string): unknown
  inject?: (names: readonly string[], callback: (scope: StoreContext) => void) => unknown
  effect?: (factory: () => Promise<() => Promise<void>>, label: string) => unknown
}
const sizeOf = (id: string, data: unknown): number => Buffer.byteLength(JSON.stringify([id, data]))
export const MAX_STORED_EVIDENCE_BYTES = 64 * 1024 * 1024

/** per-record backends use each key as a path segment; digest the evidence key. */
export function evidenceRecordKey(key: string): string {
  return `e${stableDigest(key)}`
}

export class EvidenceStore {
  private table?: Table
  private ready: Promise<void> = Promise.resolve()
  private chain: Promise<void> = Promise.resolve()
  private disposed = false
  /** LRU touches kept in memory until the next put or dispose merges them. */
  private touches = new Map<string, number>()
  private reportedMissing = false
  constructor(private readonly limit = MAX_STORED_EVIDENCE_BYTES,
    private readonly report: (error: unknown) => void = error => console.error('vision: evidence storage unavailable', error)) {}

  install(ctx: StoreContext): void {
    if (ctx.inject !== undefined) ctx.inject(['storageDomain'], scope => this.open(scope))
    else this.open(ctx)
  }

  private open(ctx: StoreContext): void {
    this.disposed = false
    const storage = ctx.get('storageDomain') as { open(spec: typeof evidenceDomain): Promise<{ table(name: string): Table; close(): Promise<void> }> } | undefined
    if (storage === undefined || ctx.effect === undefined) {
      // Persistence degrades to the memory cache; surface that once instead of
      // silently losing cross-process evidence or reporting on every install.
      if (!this.reportedMissing) {
        this.reportedMissing = true
        this.report(new Error('vision: storageDomain service unavailable; evidence persistence disabled'))
      }
      return
    }
    const opened = Promise.resolve().then(() => storage.open(evidenceDomain))
    this.ready = opened.then(domain => { this.table = domain.table('evidence') }, error => { this.report(error) })
    ctx.effect(async () => {
      await this.ready
      return async () => {
        // Merge pending touches through the transaction chain (which also
        // flushes queued writes) before the domain closes.
        const flush = this.chain.then(async () => {
          await this.ready
          try { await this.flushTouches() } catch (error) { this.report(error) }
        })
        this.chain = flush.then(() => {}, () => {})
        this.disposed = true
        await this.chain
        this.table = undefined
        await opened.then(domain => domain.close(), () => {})
      }
    }, 'vision: persistent evidence')
  }

  /** Structural table injection also exercises the same storage failure path in tests. */
  attach(table: Table): void { this.table = table }

  private transact<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    if (this.disposed) return Promise.resolve(fallback)
    const run = this.chain.then(async () => {
      await this.ready
      try { return await work() } catch (error) { this.report(error); return fallback }
    })
    this.chain = run.then(() => {}, () => {})
    return run
  }

  /** Persist pending LRU touches; a failed touch only loses recency metadata. */
  private async flushTouches(): Promise<void> {
    const table = this.table
    if (table === undefined) return
    for (const [key, time] of this.touches) {
      const raw = table.get(key)
      const parsed = raw === undefined ? undefined : rowSchema.safeParse(raw)
      if (parsed?.success !== true) { this.touches.delete(key); continue }
      try {
        await table.put(key, { ...parsed.data, lastUsedAt: time })
        this.touches.delete(key)
      } catch (error) { this.report(error) }
    }
  }

  get(key: string): Promise<EvidenceRow | undefined> {
    return this.transact(async () => {
      const record = evidenceRecordKey(key)
      const raw = this.table?.get(record)
      if (raw === undefined) return undefined
      const parsed = rowSchema.safeParse(raw)
      if (!parsed.success) { this.touches.delete(record); await this.table?.delete(record); return undefined }
      // The LRU touch updates memory only; a read hit must not produce a write.
      const touched = Date.now()
      this.touches.set(record, touched)
      return { ...parsed.data, lastUsedAt: touched }
    }, undefined)
  }

  put(key: string, value: Omit<EvidenceRow, 'createdAt' | 'lastUsedAt'>): Promise<void> {
    return this.transact(async () => {
      const table = this.table
      if (table === undefined) return
      const record = evidenceRecordKey(key)
      const previous = rowSchema.safeParse(table.get(record))
      const now = Date.now()
      this.touches.delete(record)
      const row = { ...value, createdAt: previous.success ? previous.data.createdAt : now, lastUsedAt: now }
      if (sizeOf(record, row) > this.limit) return
      await table.put(record, row)
      const rows: Array<{ key: string; size: number; time: number }> = []
      let total = 0
      for (const [id, data] of table.entries()) {
        const parsed = rowSchema.safeParse(data)
        if (!parsed.success) { this.touches.delete(id); await table.delete(id); continue }
        const size = sizeOf(id, data)
        total += size
        // In-memory touches are newer than any persisted lastUsedAt.
        rows.push({ key: id, size, time: this.touches.get(id) ?? parsed.data.lastUsedAt })
      }
      rows.sort((a, b) => a.time - b.time)
      for (const old of rows) {
        if (total <= this.limit) break
        await table.delete(old.key)
        this.touches.delete(old.key)
        total -= old.size
      }
      await this.flushTouches()
    }, undefined)
  }
}

/** One global queue per plugin cache; queued cancellation never starts an upload. */
export class EvidenceQueue {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(private readonly concurrency: number) {}
  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(visionAborted(signal))
      }
      const start = () => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) { reject(visionAborted(signal)); return }
        this.active += 1
        void work().then(resolve, reject).finally(() => {
          this.active -= 1
          this.waiting.shift()?.()
        })
      }
      if (signal.aborted) { reject(visionAborted(signal)); return }
      if (this.active < this.concurrency) start()
      else { this.waiting.push(start); signal.addEventListener('abort', abort, { once: true }) }
    })
  }
}
