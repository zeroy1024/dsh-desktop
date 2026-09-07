import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as Native from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config, PiAiModelProfile as ModelConfig } from '@deepseek-ai/dsh-llm-pi-ai'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closers.splice(0).map(fn => fn())); vi.unstubAllEnvs() })
async function runtime(raw: Config) {
  vi.stubEnv('SELF_API_KEY', 'test-shared-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Native, Native.Config(raw))
  closers.push(() => ctx.fiber.dispose())
  return ctx
}
function config(models: ModelConfig[], baseURL = 'http://127.0.0.1:1') {
  return { providers: { self: { baseURLMode: 'api-root' as const, reasoning: undefined as Native.PiAiProviderProfile['reasoning'], displayName: 'Self', baseURL, apiKeyEnv: 'SELF_API_KEY', api: 'openai-completions', models } } }
}
it('normalizes the settings schema without inventing model capabilities', () => {
  const raw = config([{ id: 'plain' }])
  const normalized = Native.Config(raw)
  expect(normalized.providers!.self.models![0].thinking?.mode ?? 'inherit').toBe('inherit')
})
it('resolves model defaults and ignores an unsupported provider fallback', async () => {
  const raw = config([
    { id: 'a', thinking: { mode: 'levels', levels: ['low', 'high'], default: 'low' } },
    { id: 'b', thinking: { mode: 'levels', levels: ['high'] } },
    { id: 'fixed', api: 'anthropic-messages', thinking: { mode: 'always-on', wire: 'anthropic-enabled' } },
  ])
  raw.providers.self.reasoning = 'max'
  const ctx = await runtime(raw)
  expect(ctx.llm.listConfigurableProviders().find(p => p.provider === 'self')).toMatchObject({ settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'self'] })
  expect((await ctx.llm.resolveModelInfo('self', 'a')).reasoning?.defaultEffort).toBe('low')
  expect((await ctx.llm.resolveModelInfo('self', 'b')).reasoning?.defaultEffort).toBeUndefined()
  expect((await ctx.llm.resolveModelInfo('self', 'fixed')).reasoning?.efforts.map(x => x.id)).toEqual(['on'])
  await expect(ctx.llm.resolveCallConfig({ provider: 'self', model: 'fixed', reasoningEffort: ReasoningEffortId('off') })).rejects.toThrow()
})

it('dispatches one provider and one credential through three actual HTTP serializers', async () => {
  const requests: { path: string; body: Record<string, any>; auth: unknown; key: unknown }[] = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    requests.push({ path: req.url!, body: JSON.parse(text), auth: req.headers.authorization, key: req.headers['x-api-key'] })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (req.url?.includes('messages')) {
      res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
    } else if (req.url?.includes('responses')) {
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
    } else res.end('data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise(resolve => server.close(() => resolve())))
  const raw = config([
    { id: 'chat', thinking: { mode: 'levels', levels: ['low', 'high'], default: 'low' }, reasoningEfforts: { low: 'medium', high: 'high' }, compat: { supportsReasoningEffort: true } },
    { id: 'm3', api: 'anthropic-messages', thinking: { mode: 'toggle', default: 'on', wire: 'anthropic-adaptive' } },
    { id: 'fixed', api: 'anthropic-messages', thinking: { mode: 'always-on', wire: 'anthropic-enabled' } },
    { id: 'responses', api: 'openai-responses', thinking: { mode: 'levels', levels: ['high'], default: 'high' } },
  ], `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)
  const ctx = await runtime(raw)
  for (const [model, effort] of [['chat'], ['m3'], ['m3', 'off'], ['fixed'], ['responses']]) {
    const chunks = []
    for await (const chunk of ctx.llm.stream({ provider: 'self', model, messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'plugin', plugin: 'test' } })], ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}) })) chunks.push(chunk)
    expect(chunks.some(x => x.type === 'finish')).toBe(true)
    expect(JSON.stringify(chunks)).not.toContain('"reason":"error"')
  }
  expect(requests.map(x => x.path)).toEqual(['/v1/chat/completions', '/v1/messages', '/v1/messages', '/v1/messages', '/v1/responses'])
  expect(requests.every(x => x.auth === 'Bearer test-shared-key' || x.key === 'test-shared-key')).toBe(true)
  expect(requests[0].body.reasoning_effort).toBe('medium')
  expect(requests[1].body.thinking).toEqual({ type: 'adaptive' })
  expect(requests[1].body.output_config).toBeUndefined()
  expect(requests[2].body.thinking).toEqual({ type: 'disabled' })
  expect(requests[3].body.thinking).toEqual({ type: 'enabled' })
  expect(requests[4].body.reasoning.effort).toBe('high')
})
