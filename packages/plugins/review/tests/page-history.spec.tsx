// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReviewPage } from '../src/client/ReviewPage.tsx'
import * as api from '../src/client/api.ts'
import type { GitSnapshot, HistoryPageLite } from '../src/client/api.ts'
import { sessionData, type SessionData } from '../src/client/session-data.ts'
import { rewindHistoryFixture } from './rewind-history.fixture.ts'

vi.mock('../src/client/FileSection.tsx', () => ({ FileSection: ({ file }: { file: { path: string } }) => <div>{file.path}</div> }))
vi.mock('../src/client/GitFileSection.tsx', () => ({ GitFileSection: ({ file, onRevert }: { file: { path: string }; onRevert: () => void }) => <button onClick={onRevert}>restore {file.path}</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('does not resurrect an edit when rewind replaces the window during paging', async () => {
  let resolveOlder!: (page: HistoryPageLite) => void
  const older = new Promise<HistoryPageLite>(resolve => { resolveOlder = resolve })
  const data: SessionData = {
    history: vi.fn()
      .mockResolvedValueOnce({ hasMore: true, nextBeforeSeq: 20, events: [{ event: {
        seq: 20, time: 1, type: 'tool/result', data: {
          meta: { diffs: [{ path: 'rewound.ts', oldText: null, newText: 'old' }] },
        },
      } }] })
      .mockReturnValueOnce(older)
      .mockResolvedValue({ hasMore: false, events: [] }),
    subscribe: () => () => {},
    send: async () => {},
  }
  render(<ReviewPage sessionId="s1" active={true} data={data} t={key => key} />)
  await waitFor(() => expect(data.history).toHaveBeenCalledWith(20, expect.any(AbortSignal)))
  await act(async () => { resolveOlder({ hasMore: false, events: [] }); await older })
  expect(await screen.findByText('empty.title')).toBeTruthy()
  expect(screen.queryByText('rewound.ts')).toBeNull()
})


it('reloads Git on session switch and ignores the old workspace response', async () => {
  let resolveOld!: (snapshot: GitSnapshot) => void
  const old = new Promise<GitSnapshot>(resolve => { resolveOld = resolve })
  const fetch = vi.spyOn(api, 'fetchGitSnapshot')
    .mockReturnValueOnce(old)
    .mockResolvedValue({ ok: true, git: false })
  const data: SessionData = {
    history: async () => ({ hasMore: false, events: [] }),
    subscribe: () => () => {},
    send: async () => {},
  }
  const view = render(<ReviewPage sessionId="s1" active={true} data={data} t={key => key} />)
  await screen.findByText('empty.title')
  fireEvent.click(screen.getByText('mode.git'))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('s1'))
  view.rerender(<ReviewPage sessionId="s2" active={true} data={data} t={key => key} />)
  expect(await screen.findByText('git.unavailable')).toBeTruthy()
  expect(fetch).toHaveBeenCalledWith('s2')
  await act(async () => {
    resolveOld({ ok: true, git: true, branch: 'old-workspace', status: [], diffText: '', truncated: false })
    await old
  })
  expect(screen.queryByText('old-workspace')).toBeNull()
  expect(screen.getByText('git.unavailable')).toBeTruthy()
})


const emptyData: SessionData = {
  history: async () => ({ hasMore: false, events: [] }), subscribe: () => () => {}, send: async () => {},
}
function gitSnapshot(path: string): GitSnapshot {
  return { ok: true, git: true, branch: path, status: [], truncated: false,
    diffText: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  }
}

it('does not let a completed restore in A replace the selected B workspace or target its paths', async () => {
  let resolveRestore!: () => void
  const pending = new Promise<void>(resolve => { resolveRestore = resolve })
  const reads = vi.spyOn(api, 'fetchGitSnapshot').mockImplementation(async id => gitSnapshot(`${id}.ts`))
  const restore = vi.spyOn(api, 'restoreGitFile').mockReturnValueOnce(pending).mockResolvedValue(undefined)
  const view = render(<ReviewPage sessionId="A" active data={emptyData} t={key => key} />)
  await screen.findByText('empty.title')
  fireEvent.click(screen.getByText('mode.git'))
  fireEvent.click(await screen.findByText('restore A.ts'))
  fireEvent.click(screen.getByText('restore A.ts'))
  expect(restore).toHaveBeenCalledWith('A', 'A.ts')
  view.rerender(<ReviewPage sessionId="B" active data={emptyData} t={key => key} />)
  await screen.findByText('restore B.ts')
  await act(async () => { resolveRestore(); await pending })
  expect(reads.mock.calls.map(([id]) => id)).toEqual(['A', 'B'])
  expect(screen.queryByText('restore A.ts')).toBeNull()
  fireEvent.click(screen.getByText('restore B.ts'))
  fireEvent.click(screen.getByText('restore B.ts'))
  expect(restore).toHaveBeenLastCalledWith('B', 'B.ts')
})

it('leaves hidden review pages idle and stops paging after the tab is hidden', async () => {
  let resolvePage!: (value: HistoryPageLite) => void
  const pending = new Promise<HistoryPageLite>(resolve => { resolvePage = resolve })
  const data: SessionData = { ...emptyData, history: vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ events: [], hasMore: false }) }
  const view = render(<ReviewPage sessionId="A" active={false} data={data} t={key => key} />)
  expect(data.history).not.toHaveBeenCalled()
  view.rerender(<ReviewPage sessionId="A" active data={data} t={key => key} />)
  await waitFor(() => expect(data.history).toHaveBeenCalledOnce())
  view.rerender(<ReviewPage sessionId="A" active={false} data={data} t={key => key} />)
  await act(async () => {
    resolvePage({ events: [{ event: { seq: 50, type: 'user/message', time: 1 } }], hasMore: true, nextBeforeSeq: 50 })
    await pending
  })
  expect(data.history).toHaveBeenCalledOnce()
  view.rerender(<ReviewPage sessionId="B" active={false} data={data} t={key => key} />)
  expect(data.history).toHaveBeenCalledOnce()
})

it('shows an incomplete-page error instead of reporting no session changes', async () => {
  const data: SessionData = { ...emptyData, history: async () => ({ events: [], hasMore: true }) }
  render(<ReviewPage sessionId="A" active data={data} t={key => key} />)
  expect(await screen.findByText('error.load')).toBeTruthy()
  expect(screen.queryByText('empty.title')).toBeNull()
})

it('pages through fully withdrawn history to find older visible edits', async () => {
  const fixture = rewindHistoryFixture()
  render(<ReviewPage sessionId="A" active data={sessionData(fixture.session)} t={key => key} />)
  expect(await screen.findByText('kept.ts')).toBeTruthy()
  expect(screen.queryByText('error.load')).toBeNull()
  expect(fixture.session.loadOlder).toHaveBeenCalledTimes(2)
  fixture.dispose()
})
