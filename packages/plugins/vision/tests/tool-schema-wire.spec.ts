import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Native from '@deepseek-ai/dsh-llm-pi-ai'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { installOnDemand, ANALYZE_IMAGE_TOOL } from '../src/on-demand.ts'
import { makeEvidenceCache } from '../src/index.ts'

afterEach(() => vi.unstubAllEnvs())

it('sends an object-rooted vision schema from the real tool registry through all three SDK serializers', async () => {
  const requests: { path: string; body: Record<string, any> }[] = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    requests.push({ path: req.url!, body: JSON.parse(text) })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (req.url?.includes('messages')) {
      res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
    } else if (req.url?.includes('responses')) {
      res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
    } else res.end('data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
  })
  const ctx = new Context()
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Only satisfy the registration lifecycle here; the registry and its schema
    // projection are real. Merely advertising a tool must never analyze images.
    const get = (name: string) => ctx.get(name)
    const options = vi.fn((): never => { throw new Error('Unexpected vision execution') })
    installOnDemand({ get, inject: (_names, callback) => callback({ get }) }, options, makeEvidenceCache(() => 4))
    const tools = ctx.tools.schemas().filter(tool => tool.name === ANALYZE_IMAGE_TOOL)
    expect(tools).toHaveLength(1)
    const expected = {
      type: 'object', required: ['image_ref'], properties: {
        image_ref: { type: 'string', description: expect.any(String) },
        question: { type: 'string', description: expect.any(String) },
      },
    }
    expect(tools[0].parameters).toEqual(expected)
    await ctx.plugin(LlmRuntime)
    vi.stubEnv('VISION_SCHEMA_TEST_KEY', 'local-test-key')
    await ctx.plugin(Native, Native.Config({ providers: { schema_test: {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      baseURLMode: 'api-root', apiKeyEnv: 'VISION_SCHEMA_TEST_KEY',
      models: [
        { id: 'deepseek-v4-flash', api: 'openai-completions' },
        { id: 'responses', api: 'openai-responses' },
        { id: 'messages', api: 'anthropic-messages' },
      ],
    } } }))
    for (const model of ['deepseek-v4-flash', 'responses', 'messages']) {
      const chunks = []
      for await (const chunk of ctx.llm.stream({ provider: 'schema_test', model, tools,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })],
      })) chunks.push(chunk)
      expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)
      expect(JSON.stringify(chunks)).not.toContain('"reason":"error"')
    }
    expect(requests.map(request => request.path)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/messages'])
    const [chat, responses, messages] = requests.map(request => request.body.tools[0])
    expect(chat.function.name).toBe(ANALYZE_IMAGE_TOOL)
    expect(chat.function.parameters).toEqual(expected)
    expect(responses.name).toBe(ANALYZE_IMAGE_TOOL)
    expect(responses.parameters).toEqual(expected)
    expect(messages.name).toBe(ANALYZE_IMAGE_TOOL)
    expect(messages.input_schema).toEqual(expected)
    expect(options).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
