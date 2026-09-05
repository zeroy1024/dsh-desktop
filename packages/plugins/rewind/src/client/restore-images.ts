import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerAttachment, IConversation, InputActions, InputState, SessionInput, UserMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

export class RewindPreparationError extends Error {
  constructor(readonly code: 'errorInputBusy' | 'errorImagesUnavailable' | 'errorImagesRejected') {
    super(code)
    this.name = 'RewindPreparationError'
  }
}

export interface RewindImageRuntime {
  readonly drafts: Pick<IConversation, 'createDraftImages' | 'releaseDraftImages'>
  readonly readAttachment: SessionFace['readAttachment']
  readonly inputState: {
    getSnapshot(): Pick<InputState, 'phase'>
    subscribe: SessionInput['state']['subscribe']
  }
  /** Plugin lifetime, independent of a message disappearing after its own rewind. */
  readonly signal: AbortSignal
  /** Register one attempt's cleanup on the original Session scope. */
  readonly onSessionDispose: (dispose: () => void) => () => Promise<void>
}

function waitForInput(runtime: RewindImageRuntime, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const busy = (): boolean => {
    const phase = runtime.inputState.getSnapshot().phase
    return phase === 'adjudicating' || phase === 'submitting'
  }
  if (!busy()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let off: (() => void) | undefined
    const cleanup = (): void => { off?.(); signal.removeEventListener('abort', abort) }
    const abort = (): void => { cleanup(); reject(signal.reason) }
    const check = (): void => { if (!busy()) { cleanup(); resolve() } }
    off = runtime.inputState.subscribe(check)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else check()
  })
}

/** Prepare every historical image before the destructive request; transfer ownership only on success. */
export async function prepareRewindImages(
  content: UserMessageNode['content'],
  runtime: RewindImageRuntime | undefined,
  preparing: AbortSignal,
) {
  const images = content.filter(block => block.type === 'image')
  if (images.length > 0 && runtime === undefined) throw new RewindPreparationError('errorImagesUnavailable')
  const session = new AbortController()
  const releaseScope = runtime?.onSessionDispose(() => { session.abort() })
  const lifetime = runtime === undefined ? session.signal : AbortSignal.any([session.signal, runtime.signal])
  const signal = AbortSignal.any([preparing, lifetime])
  let owned: readonly ComposerAttachment[] = []
  try {
    signal.throwIfAborted()
    const files = await Promise.all(images.map(async image => {
      const result = await runtime!.readAttachment(image.attachment.attachmentId)
      signal.throwIfAborted()
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const { attachment, data } = result.value
      return new File([Uint8Array.from(data).buffer], attachment.name ?? 'image', { type: attachment.mediaType })
    }))
    signal.throwIfAborted()
    owned = files.length === 0 ? [] : runtime!.drafts.createDraftImages(files)
  } catch (error) {
    await releaseScope?.()
    throw error
  }
  return {
    async fill(actions: Pick<InputActions, 'addImages' | 'setDraft'>, text: string): Promise<void> {
      // A message can disappear or its session can leave the stage while the
      // request is in flight. The captured actions still belong to that session.
      if (runtime !== undefined) await waitForInput(runtime, lifetime)
      lifetime.throwIfAborted()
      if (owned.length > 0) {
        while (!actions.addImages(owned.map(image => image.id))) {
          if (runtime === undefined) throw new RewindPreparationError('errorImagesUnavailable')
          const phase = runtime.inputState.getSnapshot().phase
          if (phase !== 'adjudicating' && phase !== 'submitting') throw new RewindPreparationError('errorImagesRejected')
          await waitForInput(runtime, lifetime)
          lifetime.throwIfAborted()
        }
        // addImages commits ownership synchronously. A later editor/mirror
        // error must not revoke resources already retained by the composer.
        owned = []
      }
      actions.setDraft(text)
    },
    async dispose(): Promise<void> {
      if (owned.length > 0) {
        runtime!.drafts.releaseDraftImages(owned)
        owned = []
      }
      await releaseScope?.()
    },
  }
}
