import { afterEach, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { projectOnDemand, installOnDemand, imageReference, ANALYZE_IMAGE_TOOL } from '../src/on-demand.ts'
import { makeEvidenceCache, resolveOptions, rewriteMessages, installImageInputTransform } from '../src/index.ts'
import type { Message, ContentBlock } from '../src/core.ts'

const image = (id: string) => ({ type: 'image' as const, attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3 } })
function user(id: string) { return createUserMessage({ content: [image(id) as never], source: { kind: 'user' } }) }
function setup() {
  const session = Session.create(SessionId('test'))
  session.append('turn/start', { turn: 1 })
  for (let i = 0; i < 20; i++) session.append('user/message', user(String(i)), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: 'completed' as never })
  session.append('turn/start', { turn: 2 })
  const agent = { session } as Agent
  const registered = new Map<string, ToolDefinition>()
  const tools = { register: (tool: ToolDefinition) => { registered.set(tool.name, tool) }, get: (name: string) => registered.get(name), schemas: () => [...registered.values()] }
  const readImage = vi.fn(async () => ({ data: new Uint8Array([1,2,3]), ref: { mediaType: 'image/png' } }))
  const services: Record<string, unknown> = { agents: { currentInitiator: () => agent }, tools, attachments: { readImage } }
  interface Scope { get(name: string): unknown; inject(names: readonly string[], callback: (scope: Scope) => void): void }
  const ctx: Scope = { get: (name: string) => services[name], inject: (_names: readonly string[], callback: (scope: Scope) => void) => callback(ctx) }
  const opts = { ...resolveOptions(ctx, { baseURL: 'https://vision.invalid' }), resolveApiKey: async () => 'test-key' }
  const cache = makeEvidenceCache(() => 4)
  installOnDemand(ctx, () => opts, cache)
  const fetch = vi.fn(async () => new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'evidence'}]}]})))
  vi.stubGlobal('fetch', fetch)
  const request = () => ({ provider: 'p', model: 'm', toolNames: [ANALYZE_IMAGE_TOOL], messages: session.deriveMessages() as unknown as Message[] })
  const project = () => projectOnDemand(ctx, opts, cache, request())
  const analyze = (ref: string, question?: string, subject = agent) => registered.get(ANALYZE_IMAGE_TOOL)!.execute({ image_ref: ref, ...(question === undefined ? {} : { question }) }, { agent: subject, signal: new AbortController().signal } as ToolRunContext)
  return {session,agent,services,ctx,opts,cache,fetch,readImage,request,project,analyze,registered}
}
afterEach(() => vi.unstubAllGlobals())

it('compiles parameter/output schemas and rejects malformed arguments before I/O', async () => {
  const h = setup()
  const tool = h.registered.get(ANALYZE_IMAGE_TOOL)!
  expect(tool.parameters).toMatchObject({ type: 'object', required: ['image_ref'], properties: {
    image_ref: { type: 'string' }, question: { type: 'string' },
  } })
  expect(tool.output?.schema).toMatchObject({ type: 'object', required: ['image_ref', 'text', 'cached'], additionalProperties: false })
  for (const args of [null, [], {}, { image_ref: 1 }, { image_ref: 'x', question: false }]) {
    await expect(tool.execute(args, { agent: h.agent, signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow()
  }
  expect(h.readImage).not.toHaveBeenCalled()
  expect(h.fetch).not.toHaveBeenCalled()
})

it('projects 20 uncached historical images without reads or network and preserves history', async () => {
  const h = setup()
  const before = JSON.stringify(h.session.deriveMessages())
  const output = await h.project()
  expect(output).toHaveLength(20)
  expect(JSON.stringify(output)).toContain('尚未分析')
  expect(h.fetch).not.toHaveBeenCalled()
  expect(h.readImage).not.toHaveBeenCalled()
  expect(JSON.stringify(h.session.deriveMessages())).toBe(before)
})
it('automatically transcribes only current-turn new images and reuses them on the next step', async () => {
  const h = setup()
  h.session.append('user/message', user('new'), {surfaceOp:'append'})
  expect(JSON.stringify(await h.project())).toContain('evidence')
  await h.project()
  expect(h.fetch).toHaveBeenCalledOnce()
})
it('reads only requested images, keys questions separately, rejects foreign/removed references before I/O', async () => {
  const h = setup()
  const ref = imageReference(h.session.id,image('0'))
  expect(await h.analyze(ref)).toMatchObject({text:'evidence',cached:false})
  expect(await h.analyze(ref)).toMatchObject({cached:true})
  await h.analyze(ref,'error code?')
  await h.analyze(ref,' error code? ')
  expect(h.fetch).toHaveBeenCalledTimes(2)
  await expect(h.analyze(imageReference('other',image('0')))).rejects.toThrow('not available')
  const other = { session: Session.create(SessionId('other')) } as Agent
  await expect(h.analyze(ref,undefined,other)).rejects.toThrow('not available')
  expect(h.fetch).toHaveBeenCalledTimes(2)
  vi.spyOn(h.session,'deriveMessages').mockReturnValue([])
  await expect(h.analyze(ref)).rejects.toThrow('not available')
  expect(h.readImage).toHaveBeenCalledTimes(2)
})
it('falls back for no-tool calls, unknown message identities and immediate mode', async () => {
  const h = setup()
  expect(await projectOnDemand(h.ctx,h.opts,h.cache,{...h.request(),toolNames:[]})).toBeUndefined()
  expect(await projectOnDemand(h.ctx,h.opts,h.cache,{...h.request(),messages:[{content:[image('x')]}]})).toBeUndefined()
  expect(await projectOnDemand(h.ctx,{...h.opts,transcriptionMode:'immediate'},h.cache,h.request())).toBeUndefined()
})
it('immediate mode transcribes all historical images with global concurrency bounded to two', async () => {
  const h = setup()
  let active = 0; let peak = 0
  h.readImage.mockImplementation(async () => {
    active++; peak = Math.max(peak,active)
    await new Promise(resolve => setTimeout(resolve,2));active--
    return {data:new Uint8Array([1]),ref:{mediaType:'image/png'}}
  })
  await rewriteMessages(h.opts,{readImage:h.readImage},h.cache,h.request().messages)
  expect(h.fetch).toHaveBeenCalledTimes(20)
  expect(peak).toBe(2)
})
it('restored and inherited messages are never considered new', async () => {
  const h = setup()
  const restored = Session.create(SessionId('restored'), h.session.snapshotEvents())
  const agent = {session:restored} as Agent
  h.services.agents = {currentInitiator:()=>agent}
  const output = await projectOnDemand(h.ctx,h.opts,h.cache,{...h.request(),messages:restored.deriveMessages() as unknown as Message[]})
  expect(JSON.stringify(output)).toContain('尚未分析')
  expect(h.fetch).not.toHaveBeenCalled()
})
it('preserves nested tool results and skips native image routes in the real transform service', async () => {
  const h = setup()
  let transform: ((request: unknown)=>unknown) | undefined
  const provide = (_name: string, service: unknown) => { transform = (service as {transform?:typeof transform}).transform ?? transform }
  installImageInputTransform({...h.ctx,provide},()=>h.opts,h.cache,undefined)
  expect(await transform?.({...h.request(),inputModalities:['text','image']})).toBeUndefined()
  expect(h.fetch).not.toHaveBeenCalled()
  const blocks: ContentBlock[] = [{type:'tool-result',toolCallId:'call',content:[{type:'text',text:'before'},image('nested'),{type:'text',text:'after'}]}]
  const output = await rewriteMessages(h.opts,{readImage:h.readImage},h.cache,[{content:blocks}])
  expect(output[0]?.content?.[0]).toMatchObject({toolCallId:'call',content:[{text:'before'},{text:'[图片证据]\nevidence'},{text:'after'}]})
})

it('compaction removes old references and does not make retained historical images new', async () => {
  const h = setup()
  const originals = h.session.snapshotEvents().filter(event => event.type === 'user/message')
  h.session.append('user/message', user('0'), {
    surfaceOp: {op:'replace',start:originals[0]!.seq,end:originals.at(-1)!.seq},
    sourceEventSeqs: originals.map(event=>event.seq),
  })
  expect(JSON.stringify(await h.project())).toContain('尚未分析')
  expect(h.fetch).not.toHaveBeenCalled()
  await expect(h.analyze(imageReference(h.session.id,image('1')))).rejects.toThrow('not available')
})
