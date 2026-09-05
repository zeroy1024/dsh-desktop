// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { projectUserText } from './ui-primitives.stub.tsx'
import { RewindUserMessage } from '../src/client/RewindUserMessage.tsx'
import type { RewindUserMessageProps } from '../src/client/types.ts'
import type { RewindImageRuntime } from '../src/client/restore-images.ts'
import { zh } from '../src/client/locales.ts'

const t = (key: string, params?: Record<string, string | number>): string => {
  const dict: Readonly<Record<string, string>> = zh
  return (dict[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ''))
}

// The public composer face has a type-only store dependency. Keep missing
// vendor packages from silently weakening this lifecycle contract to any.
expectTypeOf<RewindImageRuntime['inputState']['subscribe']>().not.toBeAny()

const node: RewindUserMessageProps['node'] = {
  key: 'user:1',
  data: {
    kind: 'user' as const,
    seq: 5,
    time: 1_700_000_000_000,
    content: [{ type: 'text', text: '帮我把这段重构' }],
  },
}

const idleSession = { running: false }
const useIdleSession = <S,>(selector: (snapshot: { running: boolean }) => S): S => selector(idleSession)

function renderMessage(overrides: Partial<RewindUserMessageProps> = {}) {
  const inputActions = { setDraft: vi.fn(), addImages: vi.fn(() => true) }
  const props: RewindUserMessageProps = {
    node,
    sessionId: 'session-1',
    t,
    inputActions,
    useSession: useIdleSession,
    ...overrides,
  }
  return { inputActions, ...render(<RewindUserMessage {...props} />) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const attachment = {
  attachmentId: 'image-1' as Parameters<RewindImageRuntime['readAttachment']>[0],
  name: 'diagram.png', mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1,
}
const imageNode: RewindUserMessageProps['node'] = {
  ...node, data: { ...node.data, content: [{ type: 'text', text: 'edit image' }, { type: 'image', attachment }] },
}
function imageRuntime() {
  const lifetime = new AbortController()
  const listeners = new Set<() => void>()
  const scopeDisposers = new Set<() => void>()
  let phase: ReturnType<RewindImageRuntime['inputState']['getSnapshot']>['phase'] = 'plain'
  const readAttachment = vi.fn<RewindImageRuntime['readAttachment']>(async () => ({
    ok: true, value: { attachment, data: Uint8Array.of(1, 2, 3) },
  }))
  let nextId = 0
  const createDraftImages = vi.fn<RewindImageRuntime['drafts']['createDraftImages']>(files => files.map(file => ({
    kind: 'image', file, previewUrl: 'blob:prepared',
    id: `draft-${++nextId}` as ReturnType<RewindImageRuntime['drafts']['createDraftImages']>[number]['id'],
  })))
  const releaseDraftImages = vi.fn<RewindImageRuntime['drafts']['releaseDraftImages']>()
  const runtime: RewindImageRuntime = {
    signal: lifetime.signal, readAttachment, drafts: { createDraftImages, releaseDraftImages },
    onSessionDispose: dispose => { scopeDisposers.add(dispose); return async () => { scopeDisposers.delete(dispose); dispose() } },
    inputState: { getSnapshot: () => ({ phase }), subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } } },
  }
  return { runtime, lifetime, readAttachment, createDraftImages, releaseDraftImages, listeners, scopeDisposers,
    disposeSession() { for (const dispose of scopeDisposers) dispose() },
    phase(next: typeof phase) { phase = next; for (const listener of listeners) listener() },
  }
}

function confirmRewind(): void {
  fireEvent.click(screen.getByRole('button', { name: '撤回并编辑该消息' }))
  fireEvent.click(screen.getByRole('button', { name: '撤回' }))
}

describe('rewind image restoration', () => {
  it('localizes unavailable image restoration before posting', async () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    renderMessage({ node: imageNode })
    confirmRewind()
    await screen.findByText(zh.errorImagesUnavailable)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('localizes a busy composer and releases prepared images before posting', async () => {
    const images = imageRuntime()
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    renderMessage({ node: imageNode, imageRuntime: images.runtime,
      inputActions: { setDraft: vi.fn(), addImages: vi.fn(() => false) },
    })
    confirmRewind()
    await screen.findByText(zh.errorInputBusy)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(images.releaseDraftImages).toHaveBeenCalledOnce()
  })

  it('localizes rejected restored images and releases their resources', async () => {
    const images = imageRuntime()
    const setDraft = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')))
    renderMessage({ node: imageNode, imageRuntime: images.runtime,
      inputActions: { setDraft, addImages: vi.fn(ids => ids.length === 0) },
    })
    confirmRewind()
    await screen.findByText(zh.errorImagesRejected)
    expect(setDraft).not.toHaveBeenCalled()
    expect(images.releaseDraftImages).toHaveBeenCalledOnce()
  })

  it('does not revoke composer-owned images when writing the draft subsequently throws', async () => {
    const images = imageRuntime()
    const addImages = vi.fn(() => true)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')))
    renderMessage({ node: imageNode, imageRuntime: images.runtime,
      inputActions: { addImages, setDraft: () => { throw new Error('draft mirror failed') } },
    })
    confirmRewind()
    await screen.findByText('撤回失败：draft mirror failed')
    expect(addImages).toHaveBeenLastCalledWith(['draft-1'])
    expect(images.releaseDraftImages).not.toHaveBeenCalled()
    expect(images.scopeDisposers.size).toBe(0)
  })

  it('prepares all image bytes before posting and transfers their draft ownership only on success', async () => {
    const images = imageRuntime()
    let resolveRead!: (value: Awaited<ReturnType<RewindImageRuntime['readAttachment']>>) => void
    images.readAttachment.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    const fetchStub = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetchStub)
    const { inputActions } = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    expect(images.readAttachment).toHaveBeenCalledExactlyOnceWith('image-1')
    expect(fetchStub).not.toHaveBeenCalled()
    await act(async () => { resolveRead({ ok: true, value: { attachment, data: Uint8Array.of(1, 2, 3) } }) })
    await waitFor(() => expect(inputActions.setDraft).toHaveBeenCalledExactlyOnceWith('edit image'))
    expect(fetchStub).toHaveBeenCalledOnce()
    expect(images.createDraftImages.mock.calls[0]?.[0][0]).toMatchObject({ name: 'diagram.png', type: 'image/png', size: 3 })
    expect(inputActions.addImages).toHaveBeenLastCalledWith(['draft-1'])
    expect(images.releaseDraftImages).not.toHaveBeenCalled()
    expect(images.scopeDisposers.size).toBe(0)
  })

  it('does not withdraw when an image cannot be read and permits a fresh retry', async () => {
    const images = imageRuntime()
    images.readAttachment.mockRejectedValueOnce(new Error('image read failed'))
    const fetchStub = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetchStub)
    const { inputActions } = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    await screen.findByText('撤回失败：image read failed')
    expect(fetchStub).not.toHaveBeenCalled()
    expect(images.createDraftImages).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(inputActions.setDraft).toHaveBeenCalled())
    expect(images.readAttachment).toHaveBeenCalledTimes(2)
  })

  it('releases prepared resources after request failure and does not reuse released ids on retry', async () => {
    const images = imageRuntime()
    const fetchStub = vi.fn().mockResolvedValueOnce(new Response('{"ok":false}', { status: 409 }))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetchStub)
    const { inputActions } = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    await waitFor(() => expect(images.releaseDraftImages).toHaveBeenCalledOnce())
    expect(inputActions.setDraft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(inputActions.setDraft).toHaveBeenCalled())
    expect(inputActions.addImages).toHaveBeenLastCalledWith(['draft-2'])
    expect(images.releaseDraftImages.mock.calls[0]?.[0].map(image => image.id)).toEqual(['draft-1'])
  })

  it('cancels preparation when the message is unmounted before the request', async () => {
    const images = imageRuntime()
    let resolveRead!: (value: Awaited<ReturnType<RewindImageRuntime['readAttachment']>>) => void
    images.readAttachment.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    const view = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    view.unmount()
    await act(async () => { resolveRead({ ok: true, value: { attachment, data: Uint8Array.of(1, 2, 3) } }) })
    expect(fetchStub).not.toHaveBeenCalled()
    expect(images.createDraftImages).not.toHaveBeenCalled()
  })

  it('finishes a submitted rewind for the original session after the selected session changes', async () => {
    const images = imageRuntime()
    let finish!: (response: Response) => void
    const fetchStub = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchStub)
    const view = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    await waitFor(() => expect(fetchStub).toHaveBeenCalledOnce())
    const other = { setDraft: vi.fn(), addImages: vi.fn(() => true) }
    view.rerender(<RewindUserMessage node={node} sessionId="B" t={t} useSession={useIdleSession} inputActions={other} />)
    await act(async () => { finish(new Response('{"ok":true}')) })
    await waitFor(() => expect(view.inputActions.setDraft).toHaveBeenCalledExactlyOnceWith('edit image'))
    expect(view.inputActions.addImages).toHaveBeenLastCalledWith(['draft-1'])
    expect(other.setDraft).not.toHaveBeenCalled()
    expect(other.addImages).not.toHaveBeenCalled()
  })

  it('finishes draft transfer if the tombstone removes the message before its HTTP response', async () => {
    const images = imageRuntime()
    let finish!: (response: Response) => void
    const fetchStub = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchStub)
    const view = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    await waitFor(() => expect(fetchStub).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => { finish(new Response('{"ok":true}')) })
    expect(view.inputActions.setDraft).toHaveBeenCalledExactlyOnceWith('edit image')
    expect(view.inputActions.addImages).toHaveBeenLastCalledWith(['draft-1'])
    expect(images.releaseDraftImages).not.toHaveBeenCalled()
  })

  it('retains prepared images until the original composer finishes an overlapping admission', async () => {
    const images = imageRuntime()
    let finish!: (response: Response) => void
    const fetchStub = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchStub)
    const { inputActions } = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    await waitFor(() => expect(fetchStub).toHaveBeenCalledOnce())
    images.phase('submitting')
    await act(async () => { finish(new Response('{"ok":true}')) })
    expect(images.listeners.size).toBe(1)
    expect(inputActions.setDraft).not.toHaveBeenCalled()
    await act(async () => { images.phase('plain') })
    await waitFor(() => expect(inputActions.setDraft).toHaveBeenCalled())
    expect(images.listeners.size).toBe(0)
  })

  it('releases images and busy-wait subscriptions if the plugin unloads before transfer', async () => {
    const images = imageRuntime()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const { inputActions } = renderMessage({ node: imageNode, imageRuntime: images.runtime })
    confirmRewind()
    await waitFor(() => expect(images.createDraftImages).toHaveBeenCalledOnce())
    images.phase('submitting')
    await act(async () => { finish(new Response('{"ok":true}')) })
    expect(images.listeners.size).toBe(1)
    await act(async () => { images.lifetime.abort() })
    expect(images.listeners.size).toBe(0)
    expect(images.releaseDraftImages).toHaveBeenCalledOnce()
    expect(inputActions.setDraft).not.toHaveBeenCalled()
  })

  it('releases prepared resources if the original session scope disappears during admission', async () => {
    const images = imageRuntime()
    const root = new Context()
    let sessionContext!: Context
    const sessionScope = root.plugin((ctx: Context) => { sessionContext = ctx })
    await sessionScope.await()
    const runtime: RewindImageRuntime = { ...images.runtime,
      onSessionDispose: dispose => sessionContext.effect(() => dispose, 'prepared image test'),
    }
    let finish!: (response: Response) => void
    const fetchStub = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchStub)
    const { inputActions } = renderMessage({ node: imageNode, imageRuntime: runtime })
    confirmRewind()
    await waitFor(() => expect(fetchStub).toHaveBeenCalledOnce())
    images.phase('submitting')
    await act(async () => { finish(new Response('{"ok":true}')) })
    expect(images.listeners.size).toBe(1)
    await act(async () => { await sessionScope.dispose() })
    expect(images.releaseDraftImages).toHaveBeenCalledOnce()
    expect(images.listeners.size).toBe(0)
    expect(images.scopeDisposers.size).toBe(0)
    expect(inputActions.setDraft).not.toHaveBeenCalled()
    await root.fiber.dispose()
  })
})

describe('RewindUserMessage', () => {
  it('renders the user bubble with the official-style action row', () => {
    renderMessage()
    expect(screen.getByText('帮我把这段重构')).toBeTruthy()
    // 动作行：时间 + 撤回（复制左侧）+ 复制。
    expect(screen.getByRole('button', { name: '撤回并编辑该消息' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(document.querySelector('[data-time-hover-root] [class*="timeStart"]')).toBeTruthy()
  })

  it('decorates reference tokens and degrades extra blocks like the official bubble', () => {
    render(
      <RewindUserMessage
        sessionId="session-1"
        t={t}
        inputActions={{ setDraft: vi.fn(), addImages: vi.fn(() => true) }}
        useSession={useIdleSession}
        renderMessageImages={undefined}
        node={{
          key: 'user:2',
          data: {
            kind: 'user',
            seq: 3,
            time: 1_700_000_000_000,
            content: [
              { type: 'text', text: '问问 @[faq](dsh-session:session-2) 再 /review 一下' },
              { type: 'reasoning', text: 'extra content' },
            ],
            referenceLabels: ['faq'],
          },
        }}
      />,
    )
    // Delegate wire references and labels to the actual host projection API.
    expect(projectUserText).toHaveBeenCalledWith('问问 @[faq](dsh-session:session-2) 再 /review 一下', ['faq'])
    expect(document.querySelector('[data-native-user-text]')).toBeTruthy()
    // 非 text/image 块以 JsonBlock 降级。
    expect(document.querySelector('[data-json-block="附加内容块"]')).toBeTruthy()
    // 会话引用摘要行。
    expect(screen.getByText('引用会话 · faq')).toBeTruthy()
  })

  it('asks for confirmation, then refills the draft and posts the tombstone', async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, atSeq: 5 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const { inputActions } = renderMessage()

    fireEvent.click(screen.getByRole('button', { name: '撤回并编辑该消息' }))
    expect(screen.getByText('撤回该消息及其后的所有回复？')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1))
    expect(fetchStub).toHaveBeenCalledWith(
      '/dsh-desktop/rewind/execute',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = fetchStub.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'session-1', atSeq: 5 })
    await waitFor(() => expect(inputActions.setDraft).toHaveBeenCalledWith('帮我把这段重构'))
  })

  it('cancels without any request', () => {
    const fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
    renderMessage()

    fireEvent.click(screen.getByRole('button', { name: '撤回并编辑该消息' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(fetchStub).not.toHaveBeenCalled()
    expect(screen.queryByText('撤回该消息及其后的所有回复？')).toBeNull()
  })

  it('keeps the rewind action unavailable while the session is running', () => {
    renderMessage({ useSession: selector => selector({ running: true }) })
    const button = screen.getByRole('button', { name: '撤回并编辑该消息' }) as HTMLButtonElement
    // 官方 branchUnavailable 同款视觉：data-unavailable 而非原生 disabled（Tooltip 需要 hover）。
    expect(button.getAttribute('data-unavailable')).toBe('true')
    fireEvent.click(button)
    expect(screen.queryByText('撤回该消息及其后的所有回复？')).toBeNull()
    // 复制按钮不受运行状态影响。
    expect((screen.getByRole('button', { name: '复制' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('maps host error codes to localized messages', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, code: 'compaction-boundary' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchStub)
    renderMessage()

    fireEvent.click(screen.getByRole('button', { name: '撤回并编辑该消息' }))
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(screen.getByText(zh.errorBoundary)).toBeTruthy())
  })
})
