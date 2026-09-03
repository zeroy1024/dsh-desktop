// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RewindUserMessage } from '../src/client/RewindUserMessage.tsx'
import type { RewindUserMessageProps } from '../src/client/types.ts'

const t = (key: string, params?: Record<string, string | number>) => {
  const dict: Record<string, string> = {
    action: '撤回编辑',
    actionAria: '撤回并编辑该消息',
    copy: '复制',
    copied: '已复制',
    confirmTitle: '撤回该消息及其后的所有回复？',
    confirmHint: '消息内容将回到输入框，可编辑后重新发送。',
    confirm: '撤回',
    cancel: '取消',
    retry: '重试',
    running: '会话运行中，请先停止再撤回',
    errorNotLive: '会话未激活',
    errorBoundary: '跨越压缩段',
    errorInvalid: '撤回点无效',
    errorHttp: `撤回失败（HTTP ${String(params?.status ?? '')}）`,
    errorGeneric: `撤回失败：${String(params?.message ?? '')}`,
  }
  return dict[key] ?? key
}

const node = {
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
  const inputActions = { setDraft: vi.fn() }
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

describe('RewindUserMessage', () => {
  it('renders the user bubble with the official-style action row', () => {
    renderMessage()
    expect(screen.getByText('帮我把这段重构')).toBeTruthy()
    // 动作行：时间 + 撤回（复制左侧）+ 复制。
    expect(screen.getByRole('button', { name: '撤回并编辑该消息' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(document.querySelector('[data-time-hover-root] [class*="timeStart"]')).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('跨越压缩段')).toBeTruthy())
  })
})
