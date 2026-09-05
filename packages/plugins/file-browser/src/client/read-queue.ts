type ReadTask = (isCurrent: () => boolean) => Promise<void>

/** One read per path; repeated invalidations coalesce into one follow-up read. */
export function createReadQueue() {
  type Pending = { task: ReadTask; version: number; promise: Promise<void> }
  const pending = new Map<string, Pending>()
  return {
    clear(): void { pending.clear() },
    run(key: string, task: ReadTask, invalidate = false): Promise<void> {
      const current = pending.get(key)
      if (current) {
        if (invalidate) { current.task = task; current.version += 1 }
        return current.promise
      }
      const entry: Pending = { task, version: 0, promise: Promise.resolve() }
      pending.set(key, entry)
      // Coalesce all invalidations in the current publication batch before I/O.
      entry.promise = Promise.resolve().then(async () => {
        while (pending.get(key) === entry) {
          const version = entry.version
          await entry.task(() => pending.get(key) === entry && entry.version === version)
          if (entry.version === version) break
        }
      }).finally(() => { if (pending.get(key) === entry) pending.delete(key) })
      return entry.promise
    },
  }
}
