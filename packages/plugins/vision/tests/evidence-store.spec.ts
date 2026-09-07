import { expect, it, vi } from 'vitest'
import { EvidenceQueue, EvidenceStore } from '../src/evidence-store.ts'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function table() {
  const rows = new Map<string, unknown>()
  return { rows, get: (key: string) => rows.get(key), entries: () => rows.entries(),
    put: vi.fn(async (key: string, row: unknown) => { rows.set(key,row) }),
    delete: vi.fn(async (key: string) => rows.delete(key)) }
}
const evidence = (text = 'description') => ({sessionId:'session',attachmentId:'image',configVersion:'v1',category:'general' as const,text})
it('reuses persisted successes across instances, deletes corrupt records, and bounds serialized size', async () => {
  const port = table()
  const first = new EvidenceStore(600)
  first.attach(port)
  await first.put('a',evidence('a'.repeat(100)))
  const second = new EvidenceStore(600)
  second.attach(port)
  expect(await second.get('a')).toMatchObject({text:'a'.repeat(100)})
  port.rows.set('corrupt',{text:42})
  expect(await second.get('corrupt')).toBeUndefined()
  expect(port.rows.has('corrupt')).toBe(false)
  await second.put('b',evidence('b'.repeat(200)))
  await second.put('c',evidence('c'.repeat(200)))
  expect([...port.rows].reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row)),0)).toBeLessThanOrEqual(600)
  expect(await second.get('c')).toBeDefined()
  await second.put('too-big',evidence('x'.repeat(700)))
  expect(await second.get('too-big')).toBeUndefined()
})
it('evicts least recently used evidence rather than recently read records', async () => {
  const port = table()
  const store = new EvidenceStore(500)
  store.attach(port)
  const now = vi.spyOn(Date,'now')
  try {
    now.mockReturnValue(1); await store.put('a',evidence('x'.repeat(50)))
    now.mockReturnValue(2); await store.put('b',evidence('x'.repeat(50)))
    now.mockReturnValue(3); await store.get('a')
    now.mockReturnValue(4); await store.put('c',evidence('x'.repeat(50)))
    expect(port.rows.has('a')).toBe(true)
    expect(port.rows.has('b')).toBe(false)
    expect(port.rows.has('c')).toBe(true)
  } finally { now.mockRestore() }
})
it('contains storage failures and keeps returning a valid record when its LRU touch fails', async () => {
  const port = table();const report=vi.fn();const store=new EvidenceStore(1000,report)
  store.attach(port)
  await store.put('a',evidence())
  port.put.mockRejectedValue(new Error('disk full'))
  expect(await store.get('a')).toMatchObject({text:'description'})
  await expect(store.put('b',evidence())).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledTimes(2)
})
it('awaits opening and flushes before closing, containing open failures', async () => {
  const port=table();const opening=deferred<{table:()=>typeof port;close:()=>Promise<void>}>()
  let dispose: (()=>Promise<void>) | undefined
  let activation: Promise<unknown> | undefined
  const store=new EvidenceStore()
  const close=vi.fn(async()=>{})
  store.install({get:()=>({open:()=>opening.promise}),effect:factory=>{activation=factory().then(value=>{dispose=value})}})
  let complete=false
  const write=store.put('a',evidence()).then(()=>{complete=true})
  await Promise.resolve();expect(complete).toBe(false)
  opening.resolve({table:()=>port,close})
  await write;await activation;await dispose?.()
  expect(port.rows.has('a')).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  await store.put('after-close',evidence());expect(port.rows.has('after-close')).toBe(false)
  const report=vi.fn();const failed=new EvidenceStore(1000,report)
  failed.install({get:()=>({open:async()=>{throw new Error('broken')}}),effect:factory=>factory()})
  expect(await failed.get('a')).toBeUndefined()
  expect(report).toHaveBeenCalledOnce()
})
it('queued cancellations never execute and do not strand later queue entries', async () => {
  const queue=new EvidenceQueue(1);const pending=deferred<string>()
  const first=queue.run(()=>pending.promise,new AbortController().signal)
  const controller=new AbortController();const skipped=vi.fn(async()=> 'skipped')
  const second=queue.run(skipped,controller.signal)
  const third=queue.run(async()=> 'third',new AbortController().signal)
  controller.abort();await expect(second).rejects.toMatchObject({code:'VISION_ABORTED'})
  pending.resolve('first');expect(await first).toBe('first');expect(await third).toBe('third')
  expect(skipped).not.toHaveBeenCalled()
})
