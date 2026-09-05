/** Compatibility adapter for runtimes predating registerInputTransform. */
import { extractFocus, isBridgedModel, messagesContainImage } from './core.ts'
import type { Message, ResolveModelInfo, VisionOptions } from './core.ts'

export const MARKER = '__dshVisionBridged'

interface GenerateOptions extends Record<string, unknown> {
  provider?: string
  model?: string
  messages?: readonly Message[]
  signal?: AbortSignal
}

interface StreamContext {
  get: (key: string) => unknown
  on?: (event: string, listener: (...args: any[]) => unknown, options?: unknown) => unknown
}

interface LegacyStreamAdapter {
  getOptions: () => VisionOptions
  configured: (options: VisionOptions) => boolean
  resolveInfo?: ResolveModelInfo
  rewrite: (
    options: VisionOptions,
    messages: readonly Message[],
    focus: string,
    signal?: AbortSignal,
  ) => Promise<readonly Message[]>
}

/** The recursion marker and stream re-entry belong exclusively to this adapter. */
export function installLegacyStreamBridge(ctx: StreamContext, adapter: LegacyStreamAdapter): void {
  const llm = ctx.get('llm') as { stream?: (options: GenerateOptions) => AsyncIterable<unknown> } | undefined
  if (llm?.stream === undefined || ctx.on === undefined) return
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<unknown>) => {
    const opts = adapter.getOptions()
    if (!adapter.configured(opts) || options[MARKER] === true) return next()
    if (typeof options.provider !== 'string' || typeof options.model !== 'string') return next()
    if (!Array.isArray(options.messages) || !messagesContainImage(options.messages)) return next()
    if (ctx.get('attachments') === undefined) return next()
    return (async function* (): AsyncGenerator<unknown> {
      const bridged = await isBridgedModel(adapter.resolveInfo, opts, options.provider as string, options.model as string, options.signal)
      if (!bridged) {
        yield* next()
        return
      }
      const focus = opts.focusHint ? extractFocus(options.messages ?? []) : ''
      const messages = await adapter.rewrite(opts, options.messages ?? [], focus, options.signal)
      yield* llm.stream?.({ ...options, messages, [MARKER]: true }) ?? next()
    })()
  })
}
