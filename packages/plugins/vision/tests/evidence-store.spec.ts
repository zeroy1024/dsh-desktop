import { expect, it, vi, afterEach } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { EvidenceQueue, EvidenceStore, evidenceDomain, evidenceRecordKey } from '../src/evidence-store.ts'
import { apply, type ImageInputTransformService } from '../src/index.ts'
import { ANALYZE_IMAGE_TOOL } from '../src/on-demand.ts'
import type { Message } from '../src/core.ts'
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
afterEach(() => vi.unstubAllGlobals())
it('reuses persisted successes across instances, deletes corrupt records, and bounds serialized size', async () => {
  const port = table()
  const first = new EvidenceStore(600)
  first.attach(port)
  await first.put('a',evidence('a'.repeat(100)))
  const second = new EvidenceStore(600)
  second.attach(port)
  expect(await second.get('a')).toMatchObject({text:'a'.repeat(100)})
  port.rows.set(evidenceRecordKey('corrupt'),{text:42})
  expect(await second.get('corrupt')).toBeUndefined()
  expect(port.rows.has(evidenceRecordKey('corrupt'))).toBe(false)
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
    expect(port.rows.has(evidenceRecordKey('a'))).toBe(true)
    expect(port.rows.has(evidenceRecordKey('b'))).toBe(false)
    expect(port.rows.has(evidenceRecordKey('c'))).toBe(true)
  } finally { now.mockRestore() }
})
it('contains storage failures and never writes on a read hit', async () => {
  const port = table();const report=vi.fn();const store=new EvidenceStore(1000,report)
  store.attach(port)
  await store.put('a',evidence())
  port.put.mockClear()
  port.put.mockRejectedValue(new Error('disk full'))
  expect(await store.get('a')).toMatchObject({text:'description'})
  expect(port.put).not.toHaveBeenCalled()
  await expect(store.put('b',evidence())).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledOnce()
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
  expect(port.rows.has(evidenceRecordKey('a'))).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  await store.put('after-close',evidence());expect(port.rows.has(evidenceRecordKey('after-close'))).toBe(false)
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
it('declares the per-record layout with path-safe record keys', () => {
  expect(evidenceDomain.layout).toBe('per-record')
  expect(evidenceRecordKey('dsh-vision:v2:a:b:c')).toMatch(/^[a-zA-Z0-9_-]+$/)
})
it('merges pending LRU touches into persisted rows on the next put and on dispose', async () => {
  const port=table();let dispose:(()=>Promise<void>)|undefined;let activation:Promise<unknown>|undefined
  const store=new EvidenceStore()
  store.install({
    get:()=>({open:async()=>({table:()=>port,close:async()=>{}})}),
    effect:factory=>{activation=factory().then(value=>{dispose=value as (()=>Promise<void>)})},
  })
  await store.put('a',evidence())
  await activation
  port.put.mockClear()
  const before=(port.rows.get(evidenceRecordKey('a')) as {lastUsedAt:number}).lastUsedAt
  const now=vi.spyOn(Date,'now')
  try {
    now.mockReturnValue(before+1000)
    expect(await store.get('a')).toMatchObject({lastUsedAt:before+1000})
    expect(port.put).not.toHaveBeenCalled()
    expect((port.rows.get(evidenceRecordKey('a')) as {lastUsedAt:number}).lastUsedAt).toBe(before)
    await store.put('b',evidence('b'))
    expect((port.rows.get(evidenceRecordKey('a')) as {lastUsedAt:number}).lastUsedAt).toBe(before+1000)
    now.mockReturnValue(before+2000)
    await store.get('b')
    port.put.mockClear()
    await dispose?.()
    expect(port.put).toHaveBeenCalledOnce()
    expect((port.rows.get(evidenceRecordKey('b')) as {lastUsedAt:number}).lastUsedAt).toBe(before+2000)
  } finally { now.mockRestore() }
})
it('reports a missing storageDomain service once instead of failing silently', async () => {
  const report=vi.fn();const store=new EvidenceStore(1000,report)
  store.install({get:()=>undefined})
  store.install({get:()=>undefined})
  expect(report).toHaveBeenCalledOnce()
  expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  expect(await store.get('missing')).toBeUndefined()
  await expect(store.put('k',evidence())).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledOnce()
})
it('delivers the transcription result without waiting for the evidence flush', async () => {
  const session=Session.create(SessionId('blocking-put'))
  session.append('turn/start',{turn:1})
  const message=createUserMessage({content:[{type:'image',attachment:{attachmentId:'img-block',mediaType:'image/png',bytes:3}} as never],source:{kind:'user'}})
  session.append('user/message',message,{surfaceOp:'append'})
  const registered=new Map<string,{name:string}>()
  const tools={register:(tool:{name:string})=>{registered.set(tool.name,tool)},get:(name:string)=>registered.get(name),schemas:()=>[...registered.values()]}
  const readImage=vi.fn(async()=>({data:new Uint8Array([1,2,3]),ref:{mediaType:'image/png'}}))
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'evidence'}]}]}))))
  const gate=deferred<void>()
  const port=table()
  port.put.mockImplementation(async(key:string,row:unknown)=>{port.rows.set(key,row);await gate.promise})
  let transform:ImageInputTransformService['transform']|undefined
  interface Scope{get(name:string):unknown;inject(names:readonly string[],callback:(scope:Scope)=>void):void;provide(name:string,service:unknown):void;effect(factory:()=>void|(()=>void|Promise<void>)|Promise<()=>Promise<void>>,label?:string):unknown}
  const services:Record<string,unknown>={
    agents:{currentInitiator:()=>({session} as unknown as Agent)},
    tools,
    attachments:{readImage},
    storageDomain:{open:async()=>({table:()=>port,close:async()=>{}})},
    settings:{installSection:(_owner:unknown,_ns:unknown,_schema:unknown,entry:unknown,hooks:{setSource(source:()=>unknown):void})=>{hooks.setSource(()=>entry)}},
    launchEnvironment:{get:(name:string)=>name==='DSH_VISION_API_KEY'?{value:'test-key'}:undefined},
    llm:{registerInputTransform:(callback:ImageInputTransformService['transform'])=>{transform=callback;return()=>{}}},
  }
  const ctx:Scope={
    get:name=>services[name],
    inject:(_names,callback)=>{callback(ctx)},
    provide:()=>{},
    effect:()=>{},
  }
  apply(ctx as never,{baseURL:'https://vision.invalid'})
  expect(transform).toBeTypeOf('function')
  const task=Promise.resolve(transform!({provider:'p',model:'m',toolNames:[ANALYZE_IMAGE_TOOL],messages:session.deriveMessages() as unknown as Message[],inputModalities:['text']}))
  let settled=false
  void task.then(()=>{settled=true},()=>{settled=true})
  await vi.waitFor(()=>{expect(port.put).toHaveBeenCalled()})
  await vi.waitFor(()=>{expect(settled).toBe(true)})
  gate.resolve()
  const output=await task
  expect(JSON.stringify(output)).toContain('evidence')
  expect([...port.rows.values()].map(row=>(row as {text:string}).text)).toContain('evidence')
})
