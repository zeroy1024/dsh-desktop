// Real Loader, Agent loop, tool execution, attachment persistence and JSON domains.
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const requireVendor = createRequire(join(root, 'vendor/dsh-cli/package.json'))
const load = async name => import(pathToFileURL(requireVendor.resolve('@deepseek-ai/'+name)).href)
const { boot } = await load('dsh-app-boot')
const { LlmAdapter, createUserMessage, ToolCallId } = await load('dsh-llm')
const { SessionId } = await load('dsh-session')
const { installModelSelection } = await load('dsh-agent')
const { imageReference } = await import('../../src/on-demand.ts')
const mode = process.argv[2] ?? 'native'
const temp = await mkdtemp(join(tmpdir(), 'vision-composition-'))
let calls = 0
let requests = []
let stage = 0
let reference
const {default:sharp} = await import(pathToFileURL(requireVendor.resolve('sharp')).href)
const originalFetch = globalThis.fetch
globalThis.fetch = async () => {
  calls++
  return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'recognized evidence' }] }] }), { headers: { 'content-type': 'application/json' } })
}
class Adapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, inputModalities: model === 'native' ? ['text','image'] : ['text'] }) }
  async *stream(request) {
    requests.push(request)
    if (stage === 1) {
      assert.equal(calls, 0, 'historical images must not upload before dispatch')
      assert.ok(JSON.stringify(request.messages).includes('尚未分析'))
      stage = 2
      const name = mode === 'ptc' ? 'run_code' : 'vision_analyze_image'
      const args = mode === 'ptc' ? { description: 'Inspect historical image', code: `return await tools.vision_analyze_image({image_ref:${JSON.stringify(reference)}})` } : { image_ref: reference }
      const id = ToolCallId('analyze-one')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (stage === 2) {
      assert.equal(calls, 1)
      assert.ok(JSON.stringify(request.messages).includes('recognized evidence'))
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let ctx
async function open() {
  const packages = [
    ['dsh-llm'], ['dsh-session'], ['dsh-session-projection'], ['dsh-system-prompt'],
    ['dsh-code-runtime-worker-thread'], ['dsh-tools', { mode }], ['dsh-agent'], ['dsh-agent-loop', { agents: [] }],
    ['dsh-storage'], ['dsh-storage-json', { root: join(temp, 'storage') }], ['dsh-storage-domain', { backend: 'json' }],
    ['dsh-attachment-local', { root: join(temp, 'attachments') }],
  ]
  const config = packages.map(([name, settings]) => ({ name: '@deepseek-ai/'+name, ...(settings ? {config:settings} : {}) }))
  config.push({ name: pathToFileURL(resolve(root, 'packages/plugins/vision/src/index.ts')).href,
    config: { baseURL: 'https://vision.invalid/v1', apiKeyEnv: 'VISION_TEST_KEY', model: 'test' } })
  const configPath = join(temp, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(config))
  ctx = await boot('vision-test', configPath, [], scope => {
    scope.provide('credentials', { resolve: async () => ({ value: 'test-key' }) })
  }, pathToFileURL(join(root, 'vendor/dsh-cli/')).href)
  ctx.llm.registerAdapter(['test'], new Adapter())
}
try {
  await open()
  const agent = ctx.agentLoop.create(SessionId('vision-test'), {provider:'test',model:'native'})
  const images = []
  for (let i=0;i<20;i++) {
    // Distinct attachment identities from distinct dimensions, not forged references.
    const png = await sharp({create:{width:i+1,height:1,channels:3,background:{r:i*10,g:30,b:100}}}).png().toBuffer()
    const ref = await ctx.attachments.saveImage({data:png,mediaType:'image/png'})
    images.push({type:'image',attachment:ref})
  }
  reference = imageReference(agent.session.id, images[0])
  agent.followup(createUserMessage({content:images,source:{kind:'user'}}))
  await agent.whenIdle()
  assert.equal(calls,0)
  const snapshot = JSON.stringify(agent.session.deriveMessages())
  installModelSelection(agent.ctx, {current:{provider:'test',model:'text'},assembled:undefined})
  stage=1
  agent.followup(createUserMessage({content:[{type:'text',text:'Inspect the first screenshot'}],source:{kind:'user'}}))
  await agent.whenIdle()
  assert.equal(stage,2)
  assert.equal(calls,1)
  assert.ok(agent.session.deriveMessages().some(m=>m.content.some(b=>b.type==='image')))
  assert.ok(snapshot.includes('image'))
  const saved = agent.session.snapshotEvents()
  assert.equal(saved.findLast(e=>e.type==='assistant/message').data.message.content.find(b=>b.type==='text')?.text,'done')
  const visionEntry = [...ctx.loader.entries()].find(entry => entry.options.name?.endsWith('/vision/src/index.ts'))
  assert.ok(visionEntry?.fiber)
  await visionEntry.fiber.dispose()
  assert.equal(ctx.tools.get('vision_analyze_image',agent),undefined,'tool must be removed on plugin unload')
  await ctx.fiber.dispose()
  ctx=undefined
  stage=3
  await open()
  // Same session and attachment identity: reconstructed host must read persisted evidence.
  const restored = ctx.agentLoop.create(SessionId('vision-test'), {provider:'test',model:'text'})
  restored.followup(createUserMessage({content:[images[0]],source:{kind:'user'}}))
  await restored.whenIdle()
  assert.equal(calls,1,'successful evidence must survive plugin/process lifetime')
  assert.ok(saved.some(e=>e.type==='tool/result'))
  console.log(JSON.stringify({ok:true,mode,calls,requests:requests.length}))
} finally {
  await ctx?.fiber.dispose()
  globalThis.fetch=originalFetch
  await rm(temp,{recursive:true,force:true})
}
