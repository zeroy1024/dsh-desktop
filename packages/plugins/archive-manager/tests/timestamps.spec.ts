import { describe, expect, it, vi } from 'vitest'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import {
  archivedIdsOf, ArchiveTimestampTracker, archiveTimestampsDomainSpec,
} from '../src/timestamps.ts'

/** 内存 fake 表：与 KvTable 的触及子集同形。 */
function fakeTable() {
  const records = new Map<string, { archivedAt: number }>()
  return {
    records,
    get(key: string) { return records.get(key) },
    entries() { return records.entries() },
    async put(key: string, value: { archivedAt: number }) { records.set(key, value) },
    async delete(key: string) { return records.delete(key) },
  }
}

function workspaceChange(archivedSessionIds: string[]): DomainChanged {
  return { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds } }
}

const delay = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('archiveTimestampsDomainSpec', () => {
  it('declares a valid domain name and table', () => {
    expect(archiveTimestampsDomainSpec.name).toBe('archive_timestamps')
    expect(archiveTimestampsDomainSpec.tables.sessions).toBeDefined()
  })
})

describe('archivedIdsOf', () => {
  it('extracts the archive set from a workspace global put', () => {
    expect(archivedIdsOf(workspaceChange(['a', 'b']))).toEqual(['a', 'b'])
  })
  it('ignores foreign domains, table writes, deletes, and malformed payloads', () => {
    expect(archivedIdsOf({ domain: 'session', table: '', key: '', operation: 'put', value: {} })).toBeUndefined()
    expect(archivedIdsOf({ domain: 'workspace', table: 'workspaces', key: 'w', operation: 'put', value: {} })).toBeUndefined()
    expect(archivedIdsOf({ domain: 'workspace', table: '', key: '', operation: 'deleted' })).toBeUndefined()
    expect(archivedIdsOf({ domain: 'workspace', table: '', key: '', operation: 'put', value: {} })).toBeUndefined()
    expect(archivedIdsOf({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: 'nope' } })).toBeUndefined()
    expect(archivedIdsOf({ domain: 'workspace', table: '', key: '', operation: 'put', value: null })).toBeUndefined()
  })

  it('accepts an empty archive set (the legit "all restored" snapshot)', () => {
    expect(archivedIdsOf(workspaceChange([]))).toEqual([])
  })
})

describe('ArchiveTimestampTracker', () => {
  it('seeds on attach and records archive time on observe', async () => {
    const now = vi.fn(() => 1000)
    const tracker = new ArchiveTimestampTracker(now)
    const table = fakeTable()
    tracker.attach(table, ['a'])
    await tracker.flush()
    expect(await tracker.read()).toEqual({ a: 1000 })

    now.mockReturnValue(2000)
    tracker.observe(workspaceChange(['a', 'b']))
    await tracker.flush()
    expect(await tracker.read()).toEqual({ a: 1000, b: 2000 })
  })

  it('drops timestamps for unarchived sessions and is idempotent on repeats', async () => {
    const tracker = new ArchiveTimestampTracker(() => 1000)
    const table = fakeTable()
    tracker.attach(table, ['a', 'b'])
    tracker.observe(workspaceChange(['a', 'b']))
    tracker.observe(workspaceChange(['a']))
    await tracker.flush()
    expect(await tracker.read()).toEqual({ a: 1000 })
  })

  it('ignores events before attach and after detach', async () => {
    const tracker = new ArchiveTimestampTracker(() => 1000)
    tracker.observe(workspaceChange(['a']))
    expect(await tracker.read()).toEqual({})

    const table = fakeTable()
    tracker.attach(table, ['a'])
    await tracker.flush()
    tracker.detach()
    tracker.observe(workspaceChange(['a', 'b']))
    expect(table.records.has('b')).toBe(false)
  })

  it('keeps reconciles serialized so a late event cannot resurrect a deleted row', async () => {
    // 慢表：每次 put/delete 让出一个宏任务，制造事件交错窗口。
    const table = fakeTable()
    const slow = {
      get: table.get,
      entries: table.entries,
      put: async (key: string, value: { archivedAt: number }) => { await delay(); await table.put(key, value) },
      delete: async (key: string) => { await delay(); return table.delete(key) },
    }
    const tracker = new ArchiveTimestampTracker(() => 1000)
    tracker.attach(slow, ['a'])
    tracker.observe(workspaceChange([])) // 全恢复：删 a
    tracker.observe(workspaceChange(['b'])) // 新归档 b
    await tracker.flush()
    expect(await tracker.read()).toEqual({ b: 1000 })
  })

  it('survives a failed write and keeps processing later events', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let failNextPut = true
    const table = fakeTable()
    const flaky = {
      ...table,
      put: async (key: string, value: { archivedAt: number }) => {
        if (failNextPut) { failNextPut = false; throw new Error('disk full') }
        await table.put(key, value)
      },
    }
    const tracker = new ArchiveTimestampTracker(() => 1000)
    tracker.attach(flaky, ['a']) // put a 失败
    tracker.observe(workspaceChange(['a', 'b'])) // 重试 a 并写 b
    await tracker.flush()
    expect(table.records.has('b')).toBe(true)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})
