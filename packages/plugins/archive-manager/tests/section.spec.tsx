// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArchiveManagerSection } from '../src/client/ArchiveManagerSection.tsx'
import type {
  ArchiveManagerSectionProps, SessionListState, SnapshotSelectorHook, WorkspaceListState,
} from '../src/client/types.ts'

const t = (key: string, params?: Record<string, string | number>) => {
  const dict: Record<string, string> = {
    title: '归档的会话',
    description: '说明',
    empty: '没有归档的会话',
    restore: '恢复',
    restoring: '恢复中…',
    restoreAria: '恢复会话',
    unknownSession: '未知会话',
    noWorkspace: '未分组',
    errorRestore: `恢复失败：${String(params?.message ?? '')}`,
    errorUnsupported: '不支持恢复',
  }
  return dict[key] ?? key
}

function makeHooks(workspaces: WorkspaceListState, sessions: SessionListState) {
  const useWorkspaces: SnapshotSelectorHook<WorkspaceListState> = selector => selector(workspaces)
  const useSessions: SnapshotSelectorHook<SessionListState> = selector => selector(sessions)
  return { useWorkspaces, useSessions }
}

const workspacesFixture: WorkspaceListState = {
  items: [{
    workspaceId: 'w1',
    title: 'AIWorkspace',
    sessionIds: ['session-aaaa1111-rest'],
  }],
  archivedSessionIds: ['session-aaaa1111-rest', 'session-bbbb2222-gone', 'session-cccc3333-lost'],
}

const sessionsFixture: SessionListState = {
  byId: {
    'session-aaaa1111-rest': {
      id: 'session-aaaa1111-rest',
      displayTitle: '修复登录页',
      updatedAt: Date.now() - 3 * 60 * 60 * 1000,
    },
    // session-cccc3333-lost 故意不在 store：列表需降级为 ID 缩略。
  },
}

function renderSection(hooks: ReturnType<typeof makeHooks>) {
  const props: ArchiveManagerSectionProps = {
    close: () => {},
    t,
    ...hooks,
  }
  return render(<ArchiveManagerSection {...props} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ArchiveManagerSection', () => {
  it('renders archived rows with metadata and falls back for unknown sessions', () => {
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    expect(screen.getByText('归档的会话')).toBeTruthy()
    expect(screen.getByText('修复登录页')).toBeTruthy()
    // 未知会话降级为去掉 session- 前缀的 8 位缩略。
    expect(screen.getByText('cccc3333…')).toBeTruthy()
    // meta 行是「相对时间 · 工作区」拼接的单个文本节点，用正则断言归属。
    expect(screen.getByText(/AIWorkspace/)).toBeTruthy()
    // bbbb/cccc 两个会话不在任何 workspace 的归属槽位里。
    expect(screen.getAllByText(/未分组/)).toHaveLength(2)
    // 按钮 accessible name 来自 aria-label（restoreAria），非按钮文本。
    expect(screen.getAllByRole('button', { name: '恢复会话' })).toHaveLength(3)
  })

  it('renders the empty state when nothing is archived', () => {
    renderSection(makeHooks(
      { items: [], archivedSessionIds: [] },
      { byId: {} },
    ))
    expect(screen.getByText('没有归档的会话')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('posts the session id to the same-origin unarchive route on click', async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    renderSection(makeHooks(workspacesFixture, sessionsFixture))

    fireEvent.click(screen.getAllByRole('button', { name: '恢复会话' })[0]!)
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1))
    expect(fetchStub).toHaveBeenCalledWith(
      '/dsh-desktop/archive-manager/unarchive',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = fetchStub.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'session-aaaa1111-rest' })
    // 成功路径静默：不渲染任何失败提示。
    await waitFor(() => expect(screen.queryByText(/恢复失败/)).toBeNull())
  })

  it('shows the unsupported notice on a 501 from the host route', async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: false, code: 'unsupported-host' }), { status: 501 }))
    vi.stubGlobal('fetch', fetchStub)
    renderSection(makeHooks(workspacesFixture, sessionsFixture))

    fireEvent.click(screen.getAllByRole('button', { name: '恢复会话' })[0]!)
    await waitFor(() => expect(screen.getByText('不支持恢复')).toBeTruthy())
    // 降级后全部按钮禁用（只读列表）。
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows an inline error when the route fails', async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchStub)
    renderSection(makeHooks(workspacesFixture, sessionsFixture))

    fireEvent.click(screen.getAllByRole('button', { name: '恢复会话' })[1]!)
    await waitFor(() => expect(screen.getByText('恢复失败：HTTP 500')).toBeTruthy())
  })
})
