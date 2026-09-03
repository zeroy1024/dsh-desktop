// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TIMESTAMPS_PATH, UNARCHIVE_PATH } from '../src/shared.ts'
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
    archivedAt: '归档',
    lastActivity: '最后活跃',
    sortBy: '排序',
    sortArchivedAt: '归档时间',
    sortUpdatedAt: '最后活跃时间',
    sortAsc: '升序 ↑',
    sortDesc: '降序 ↓',
    groupOn: '按工作区分组',
    groupOff: '不分组',
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

const HOUR = 60 * 60 * 1000

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
      updatedAt: Date.now() - 3 * HOUR,
    },
    'session-bbbb2222-gone': {
      id: 'session-bbbb2222-gone',
      displayTitle: '旧任务',
      updatedAt: Date.now() - 30 * HOUR,
    },
    // session-cccc3333-lost 故意不在 store：列表需降级为 ID 缩略。
  },
}

/** 侧车 fixture：aaaa 归档更早、bbbb 归档更晚（用于排序断言）。 */
const timestampsFixture: Record<string, number> = {
  'session-aaaa1111-rest': Date.now() - 50 * HOUR,
  'session-bbbb2222-gone': Date.now() - 10 * HOUR,
}

/** stub fetch：时间戳路由回 fixture，其余（unarchive）交给 per-test handler。 */
function stubFetch(onUnarchive?: (body: unknown) => Response) {
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === TIMESTAMPS_PATH) {
      return new Response(JSON.stringify({ ok: true, timestamps: timestampsFixture }), { status: 200 })
    }
    if (url === UNARCHIVE_PATH && onUnarchive !== undefined) return onUnarchive(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

function renderSection(hooks: ReturnType<typeof makeHooks>) {
  const props: ArchiveManagerSectionProps = {
    close: () => {},
    t,
    ...hooks,
  }
  return render(<ArchiveManagerSection {...props} />)
}

/** 当前列表里各行标题（按渲染顺序），取自恢复按钮所在 li 的首个 span。 */
const titles = () => screen.getAllByRole('button', { name: '恢复会话' })
  .map(button => button.closest('li')?.querySelector('span')?.textContent ?? '')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ArchiveManagerSection', () => {
  it('renders archived rows with both timestamps and falls back for unknown sessions', async () => {
    stubFetch()
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    expect(screen.getByText('归档的会话')).toBeTruthy()
    // 侧车时间戳渲染进 meta 行：「归档: … · 最后活跃: …」。
    await waitFor(() => expect(screen.getAllByText(/归档: .*最后活跃: /)).toHaveLength(2))
    expect(screen.getByText('旧任务')).toBeTruthy()
    // 未知会话降级为去掉 session- 前缀的 8 位缩略，且无时间戳字段。
    expect(screen.getByText('cccc3333…')).toBeTruthy()
    // meta 行是「归档 · 最后活跃 · 工作区」拼接的单个文本节点，用正则断言归属。
    expect(screen.getByText(/最后活跃: .* · AIWorkspace$/)).toBeTruthy()
    // bbbb/cccc 两个会话不在任何 workspace 的归属槽位里（组标题也含「未分组」，限定 meta span）。
    expect(screen.getAllByText(/未分组/, { selector: 'span' })).toHaveLength(2)
    // 按钮 accessible name 来自 aria-label（restoreAria），非按钮文本。
    expect(screen.getAllByRole('button', { name: '恢复会话' })).toHaveLength(3)
  })

  it('groups rows under workspace headings by default', async () => {
    stubFetch()
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    await waitFor(() => expect(screen.getByText('旧任务')).toBeTruthy())
    // AIWorkspace 组头 + 未分组组头各一。
    expect(screen.getByRole('heading', { name: /AIWorkspace/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /未分组/ })).toBeTruthy()
  })

  it('orders rows by the selected sort field and direction', async () => {
    stubFetch()
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    await waitFor(() => expect(screen.getByText('旧任务')).toBeTruthy())

    // 切不分组视图，断言平铺顺序。
    fireEvent.click(screen.getByRole('button', { name: '按工作区分组' }))
    // 默认归档时间降序：bbbb(10h) > aaaa(50h) > cccc(无时间戳垫底)。
    expect(titles()).toEqual(['旧任务', '修复登录页', 'cccc3333…'])

    fireEvent.click(screen.getByRole('button', { name: '降序 ↓' }))
    // 归档时间升序：aaaa(50h) < bbbb(10h)，无时间戳仍垫底。
    expect(titles()).toEqual(['修复登录页', '旧任务', 'cccc3333…'])

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'updatedAt' } })
    // 最后活跃时间升序：bbbb(30h 前) < aaaa(3h 前)，cccc 未知垫底。
    expect(titles()).toEqual(['旧任务', '修复登录页', 'cccc3333…'])
  })

  it('renders the empty state when nothing is archived', () => {
    stubFetch()
    renderSection(makeHooks(
      { items: [], archivedSessionIds: [] },
      { byId: {} },
    ))
    expect(screen.getByText('没有归档的会话')).toBeTruthy()
    // 工具条只在有行时出现；恢复按钮不存在。
    expect(screen.queryByRole('button', { name: '恢复会话' })).toBeNull()
  })

  it('posts the session id to the same-origin unarchive route on click', async () => {
    const fetchStub = stubFetch(() => new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 }))
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    await waitFor(() => expect(screen.getByText('旧任务')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: '恢复会话' })[0]!)
    await waitFor(() => expect(fetchStub).toHaveBeenCalledWith(
      UNARCHIVE_PATH,
      expect.objectContaining({ method: 'POST' }),
    ))
    const call = fetchStub.mock.calls.find(([url]) => url === UNARCHIVE_PATH)!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ sessionId: 'session-bbbb2222-gone' })
    // 成功路径静默：不渲染任何失败提示。
    await waitFor(() => expect(screen.queryByText(/恢复失败/)).toBeNull())
  })

  it('shows the unsupported notice on a 501 from the host route', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false, code: 'unsupported-host' }), { status: 501 }))
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    await waitFor(() => expect(screen.getByText('旧任务')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: '恢复会话' })[0]!)
    await waitFor(() => expect(screen.getByText('不支持恢复')).toBeTruthy())
    // 降级后全部按钮禁用（只读列表）。
    for (const button of screen.getAllByRole('button', { name: '恢复会话' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('shows an inline error when the route fails', async () => {
    stubFetch(() => new Response('{}', { status: 500 }))
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    await waitFor(() => expect(screen.getByText('旧任务')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: '恢复会话' })[1]!)
    await waitFor(() => expect(screen.getByText('恢复失败：HTTP 500')).toBeTruthy())
  })

  it('degrades silently when the timestamps route is unavailable', () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === TIMESTAMPS_PATH
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 })))
    renderSection(makeHooks(workspacesFixture, sessionsFixture))
    // 行仍然渲染，只是没有「归档:」字段。
    expect(screen.getByText('修复登录页')).toBeTruthy()
    expect(screen.queryByText(/归档:/)).toBeNull()
  })
})
