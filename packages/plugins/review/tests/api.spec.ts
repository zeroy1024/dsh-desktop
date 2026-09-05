import { afterEach, expect, it, vi } from 'vitest'
import { fetchGitSnapshot, restoreGitFile } from '../src/client/api.ts'
afterEach(() => vi.unstubAllGlobals())
it('uses desktop Git routes and checks HTTP failures', async () => {
  const fetch = vi.fn(async (_input: unknown, _init?: unknown) => new Response(JSON.stringify({ ok: true, git: false })))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchGitSnapshot('session a')).toEqual({ ok: true, git: false })
  expect(fetch.mock.calls[0]?.[0]).toBe('/dsh-desktop/review/git?sessionId=session%20a')
  await restoreGitFile('session a', 'check.md')
  expect(fetch).toHaveBeenLastCalledWith('/dsh-desktop/review/restore', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 'session a', path: 'check.md' }) }))
  fetch.mockImplementation(async () => new Response('', { status: 403 }))
  await expect(fetchGitSnapshot('session a')).rejects.toMatchObject({ code: 'forbidden' })
})
