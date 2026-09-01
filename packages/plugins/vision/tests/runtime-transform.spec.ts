import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installImageInputTransform, makeEvidenceCache } from '../src/index.ts'
import type { VisionOptions } from '../src/index.ts'

const options: VisionOptions = {
  enabled: true,
  protocol: 'openai-responses',
  baseURL: 'https://vision.example/v1',
  apiKeyEnv: 'DSH_VISION_API_KEY',
  model: 'vision-model',
  prompt: 'describe',
  effort: 'low',
  timeoutMs: 5_000,
  apiVersion: '2023-06-01',
  maxTokens: 4_096,
  describeMaxTokens: 1_024,
  focusHint: true,
  unknownCapabilityPolicy: 'passthrough',
  cacheSize: 8,
  maxEvidenceChars: 12_000,
  maxImageBytes: 20 * 1_024 * 1_024,
  resolveApiKey: async () => 'sk-test',
}

class RecordingTextAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(request)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('vision and LlmRuntime input-transform integration', () => {
  it('dispatches one derived text request without changing the durable image message', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new RecordingTextAdapter()
    ctx.llm.registerAdapter(['text-provider'], adapter)
    const readImage = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      ref: { mediaType: 'image/png' },
    }))
    ctx.provide('attachments', { readImage })
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'recognized evidence' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)

    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3 },
    }
    const original = createUserMessage({ content: [image as never], source: { kind: 'user' } })
    expect(installImageInputTransform(ctx as never, () => options, makeEvidenceCache(() => 8), undefined)).toBe(true)

    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'text-provider',
      model: 'text-model',
      messages: [original],
    })) chunks.push(chunk)

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.messages[0]?.content).toEqual([{
      type: 'text', text: '[图片证据]\nrecognized evidence',
    }])
    expect(adapter.calls[0]?.messages[0]?.id).toBe(original.id)
    expect(original.content).toEqual([image])
    expect(readImage).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce()

    await ctx.fiber.dispose()
  })
})
