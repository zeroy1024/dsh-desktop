/** Plugin-owned, bounded derived evidence. Original attachments remain authoritative. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_EVIDENCE_CHARS, visionAborted } from './core.ts'

const rowSchema = z.object({
  sessionId: z.string(), attachmentId: z.string(), configVersion: z.string(),
  category: z.enum(['general', 'question', 'immediate']), question: z.string().optional(),
  text: z.string().min(1).max(MAX_EVIDENCE_CHARS), createdAt: z.number(), lastUsedAt: z.number(),
})
export type EvidenceRow = z.infer<typeof rowSchema>
export const evidenceDomain = defineDomain({
  name: 'vision_evidence', version: 0,
  // Individual invalid records can be discarded without failing the complete domain.
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

export class EvidenceStore {
  private table?: Table
  private ready: Promise<void> = Promise.resolve()
  private chain: Promise<void> = Promise.resolve()
  private disposed = false
  constructor(private readonly limit = MAX_STORED_EVIDENCE_BYTES,
    private readonly report: (error: unknown) => void = error => console.error('vision: evidence storage unavailable', error)) {}

  install(ctx: StoreContext): void {
    if (ctx.inject !== undefined) ctx.inject(['storageDomain'], scope => this.open(scope))
    else this.open(ctx)
  }

  private open(ctx: StoreContext): void {
    this.disposed = false
    const storage = ctx.get('storageDomain') as { open(spec: typeof evidenceDomain): Promise<{ table(name: string): Table; close(): Promise<void> }> } | undefined
    if (storage === undefined || ctx.effect === undefined) return
    const opened = Promise.resolve().then(() => storage.open(evidenceDomain))
    this.ready = opened.then(domain => { this.table = domain.table('evidence') }, error => { this.report(error) })
    ctx.effect(async () => {
      await this.ready
      return async () => {
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

  get(key: string): Promise<EvidenceRow | undefined> {
    return this.transact(async () => {
      const raw = this.table?.get(key)
      if (raw === undefined) return undefined
      const parsed = rowSchema.safeParse(raw)
      if (!parsed.success) { await this.table?.delete(key); return undefined }
      const row = { ...parsed.data, lastUsedAt: Date.now() }
      // A failed LRU touch must not discard usable evidence.
      try { await this.table?.put(key, row) } catch (error) { this.report(error) }
      return row
    }, undefined)
  }

  put(key: string, value: Omit<EvidenceRow, 'createdAt' | 'lastUsedAt'>): Promise<void> {
    return this.transact(async () => {
      const table = this.table
      if (table === undefined) return
      const previous = rowSchema.safeParse(table.get(key))
      const now = Date.now()
      const row = { ...value, createdAt: previous.success ? previous.data.createdAt : now, lastUsedAt: now }
      if (sizeOf(key, row) > this.limit) return
      await table.put(key, row)
      const rows: Array<{ key: string; size: number; time: number }> = []
      let total = 0
      for (const [id, data] of table.entries()) {
        const parsed = rowSchema.safeParse(data)
        if (!parsed.success) { await table.delete(id); continue }
        const size = sizeOf(id, data)
        total += size
        rows.push({ key: id, size, time: parsed.data.lastUsedAt })
      }
      rows.sort((a, b) => a.time - b.time)
      for (const old of rows) {
        if (total <= this.limit) break
        await table.delete(old.key)
        total -= old.size
      }
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
