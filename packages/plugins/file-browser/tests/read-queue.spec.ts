import { expect, it, vi } from 'vitest'
import { createReadQueue } from '../src/client/read-queue.ts'

it('coalesces a batch and serializes a single fresh read after in-flight invalidations', async () => {
  const queue = createReadQueue()
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const published: string[] = []
  const read = vi.fn(async (isCurrent: () => boolean) => {
    if (read.mock.calls.length === 1) await first
    if (isCurrent()) published.push('fresh')
  })
  const pending = queue.run('a', read, true)
  queue.run('a', read, true)
  queue.run('a', read, true)
  await Promise.resolve()
  expect(read).toHaveBeenCalledOnce()
  queue.run('a', read, true)
  queue.run('a', read, true)
  expect(read).toHaveBeenCalledOnce()
  release()
  await pending
  expect(read).toHaveBeenCalledTimes(2)
  expect(published).toEqual(['fresh'])
})

it('shares normal reads and drops old work when a new session reuses a path', async () => {
  const queue = createReadQueue()
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const published: string[] = []
  const oldRead = vi.fn(async (isCurrent: () => boolean) => {
    await first
    if (isCurrent()) published.push('old')
  })
  const pending = queue.run('a', oldRead)
  expect(queue.run('a', oldRead)).toBe(pending)
  await Promise.resolve()
  queue.clear()
  await queue.run('a', async isCurrent => { if (isCurrent()) published.push('new') })
  release()
  await pending
  expect(oldRead).toHaveBeenCalledOnce()
  expect(published).toEqual(['new'])
})
