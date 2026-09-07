/** Session-aware image projection and a text-returning attachment analysis tool. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EvidenceCache, ImageBlock, Message, VisionOptions, ContentBlock } from './core.ts'
import { stableDigest, MAX_FOCUS_CHARS } from './core.ts'
import { cachedEvidence, imageBlockResult, rewriteMessages } from './index.ts'
import type { ImageInputTransformRequest } from './index.ts'

export const ANALYZE_IMAGE_TOOL = 'vision_analyze_image'
interface ContextPort { get(name: string): unknown; inject?: (names: readonly string[], callback: (scope: ContextPort) => void) => unknown }
interface ToolsPort {
  register(tool: ToolDefinition): unknown
  get(name: string, agent?: Agent): unknown
  schemas(agent?: Agent): readonly { name: string }[]
}
interface Attachments { readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array; ref: { mediaType: string } }> }
function initiator(ctx: ContextPort): Agent | undefined {
  return (ctx.get('agents') as { currentInitiator(): Agent | undefined } | undefined)?.currentInitiator()
}
export function immediateOptions(ctx: ContextPort, opts: VisionOptions): VisionOptions {
  const agent = initiator(ctx)
  return agent === undefined ? opts : { ...opts, evidenceContext: { sessionId: agent.session.id, category: 'immediate' } }
}
export function imageReference(sessionId: string, block: ImageBlock): string {
  const attachment = block.attachment as { attachmentId?: unknown }
  return `vision:${stableDigest(JSON.stringify([sessionId, attachment.attachmentId]))}`
}
export function collectImages(content: readonly ContentBlock[]): ImageBlock[] {
  return content.flatMap(block => {
    if (block.type === 'image') return [block as ImageBlock]
    if (block.type === 'tool-result' && Array.isArray(block.content)) return collectImages(block.content as ContentBlock[])
    return []
  })
}
function generalOptions(opts: VisionOptions, sessionId: string, question = ''): VisionOptions {
  return { ...opts, focusHint: question !== '', evidenceContext: {
    sessionId, category: question ? 'question' : 'general', ...(question ? { question } : {}),
  } }
}
function available(ctx: ContextPort, agent: Agent, request: ImageInputTransformRequest): boolean {
  const tools = ctx.get('tools') as ToolsPort | undefined
  if (tools?.get(ANALYZE_IMAGE_TOOL, agent) === undefined) return false
  if (request.toolNames?.includes(ANALYZE_IMAGE_TOOL)) return true
  return request.toolNames?.includes('run_code') === true
    && tools.get('run_code', agent) !== undefined
    && tools.schemas(agent).some(tool => tool.name === ANALYZE_IMAGE_TOOL)
}

export async function projectOnDemand(ctx: ContextPort, opts: VisionOptions, cache: EvidenceCache, request: ImageInputTransformRequest): Promise<Message[] | undefined> {
  if (opts.transcriptionMode === 'immediate') return undefined
  const agent = initiator(ctx)
  if (agent === undefined || !available(ctx, agent, request)) return undefined
  const session = agent.session
  const effective = session.deriveMessages()
  // A nested standalone call must not borrow the outer Agent's attachment authority.
  const effectiveIds = new Set(effective.map(message => message.id as string))
  if (request.messages.some(message => typeof message.id !== 'string' || !effectiveIds.has(message.id))) return undefined
  const events = session.snapshotEvents()
  const boundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  const fresh = new Set<string>()
  if (boundary?.type === 'turn/start') {
    for (const event of events) {
      if (event.seq <= boundary.seq || event.seq < session.firstLiveSeq || event.seq < session.inheritedEventCount) continue
      // Surface replacements (compaction) must not make older images fresh.
      if (!('surfaceOp' in event) || event.surfaceOp !== 'append') continue
      const message = session.deriveEventMessage(event)
      if (message !== null) fresh.add(message.id)
    }
  }
  const captured = generalOptions(opts, session.id)
  const attachments = ctx.get('attachments') as Attachments
  const rewrite = async (blocks: readonly ContentBlock[], message: Message): Promise<ContentBlock[]> => {
    return Promise.all(blocks.map(async (block): Promise<ContentBlock> => {
      if (request.signal?.aborted) request.signal.throwIfAborted()
      if (block.type === 'image') {
        const image = block as ImageBlock
        const ref = imageReference(session.id, image)
        const source = message.source as { kind?: string; name?: string; callId?: string } | undefined
        const metadata = JSON.stringify({ message_id: message.id, source: source?.kind, tool_call_id: source?.callId })
        const cached = await cachedEvidence(cache, image, captured, request.signal)
        let text = cached?.text
        if (text === undefined && fresh.has(String(message.id))) {
          const [rewritten] = await rewriteMessages(captured, attachments, cache, [{ content: [image] }], '', request.signal)
          const entry = rewritten?.content?.[0] as { text?: string } | undefined
          text = entry?.text
        }
        return { type: 'text', text: `[图片引用 ${ref}] ${metadata}\n${text ?? '尚未分析；不能仅根据引用推断图片内容。'}\n需要查看图片或核对细节时，调用 ${ANALYZE_IMAGE_TOOL}，image_ref="${ref}"，可提供 question。` }
      } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
        return { ...block, content: await rewrite(block.content as ContentBlock[], message) }
      }
      return block
    }))
  }
  return Promise.all(request.messages.map(async message => Array.isArray(message.content)
    ? { ...message, content: await rewrite(message.content, message) } : message))
}

export function installOnDemand(ctx: ContextPort, getOptions: () => VisionOptions, cache: EvidenceCache): void {
  ctx.inject?.(['tools', 'attachments', 'agents'], scope => {
    const tools = scope.get('tools') as ToolsPort
    tools.register(defineTool({
      name: ANALYZE_IMAGE_TOOL,
      description: 'Analyze an image reference from this conversation and return text. Read historical images when needed; do not infer their content from reference metadata. Supply a question to inspect details missing from an earlier description. In code mode call this through the tools SDK.',
      parameters: {
        image_ref: { type: 'string', required: true, description: 'Exact vision: reference shown in a conversation image placeholder.' },
        question: { type: 'string', description: 'Optional question about this image; omit for a general description.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          image_ref: { type: 'string', required: true }, text: { type: 'string', required: true }, cached: { type: 'boolean', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (typeof args.question === 'string' && args.question.length > MAX_FOCUS_CHARS) throw new Error(`question exceeds ${MAX_FOCUS_CHARS} characters`)
        const agent = exec.agent
        if (agent === undefined) throw new Error('Image analysis requires a conversation')
        const block = agent.session.deriveMessages().flatMap(message => collectImages(message.content as unknown as ContentBlock[]))
          .find(image => imageReference(agent.session.id, image) === args.image_ref)
        if (block === undefined) throw new Error('Image reference is not available in the current conversation context')
        const opts = getOptions()
        if (!opts.enabled || opts.baseURL === '') throw new Error('Vision is disabled or not configured')
        const question = typeof args.question === 'string' ? args.question.trim() : ''
        const captured = generalOptions(opts, agent.session.id, question)
        const hit = await cachedEvidence(cache, block, captured, exec.signal)
        if (hit !== undefined) return { image_ref: args.image_ref, text: hit.text, cached: true }
        const result = await imageBlockResult(block, {
          opts: captured, attachments: scope.get('attachments') as Attachments,
          cache, focus: question, signal: exec.signal,
        })
        if (!result.ok) throw result.error ?? new Error('Image analysis failed')
        return { image_ref: args.image_ref, text: result.text, cached: false }
      },
    }))
  })
}
