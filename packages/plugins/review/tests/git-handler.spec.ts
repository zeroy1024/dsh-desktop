import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createGitGetHandler, createRestoreHandler, parseStatusZ, type GitRunResult,
} from '../src/git-handler.ts'

/** 假 git 执行器：按首参数分发，记录调用。 */
function fakeRunGit(script: (args: readonly string[]) => GitRunResult): {
  runGit: (args: readonly string[]) => Promise<GitRunResult>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    runGit: async (args) => {
      calls.push([...args])
      return script(args)
    },
  }
}

/** 用真实 node:http server 端到端打请求（archive-manager 同款）。 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  try {
    await run(port)
  } finally {
    server.close()
  }
}

const TRACKED_DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

/** GET happy path 的 git 输出脚本。 */
function happyScript(args: readonly string[]): GitRunResult {
  if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n' }
  if (args[0] === 'status') return { code: 0, stdout: ' M a.ts\0?? new.txt\0' }
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n' }
  if (args[0] === 'diff' && args[1] === 'HEAD') return { code: 0, stdout: TRACKED_DIFF }
  if (args[0] === 'diff') {
    const path = args.at(-1) as string
    return { code: 1, stdout: `diff --git a/dev/null b/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+fresh\n` }
  }
  return { code: 0, stdout: '' }
}

describe('parseStatusZ', () => {
  it('解析 XY 与路径；renamed 吞并第二个 NUL token', () => {
    const entries = parseStatusZ(' M a.ts\0?? dir/b.txt\0R  old.ts\0new.ts\0')
    expect(entries).toEqual([
      { x: ' ', y: 'M', path: 'a.ts' },
      { x: '?', y: '?', path: 'dir/b.txt' },
      { x: 'R', y: ' ', path: 'old.ts', oldPath: 'new.ts' },
    ])
  })
})

describe('git GET handler', () => {
  const deps = {
    resolveRoot: async () => '/repo',
    runGit: (args: readonly string[]) => Promise.resolve(happyScript(args)),
  }

  it('方法不对 405；缺 sessionId 400；未知会话 404', async () => {
    const handler = createGitGetHandler(deps)
    await withServer(handler, async (port) => {
      const post = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/git`, { method: 'POST' })
      expect(post.status).toBe(405)
      const noSession = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/git`)
      expect(noSession.status).toBe(400)
    })
    const strict = createGitGetHandler({
      resolveRoot: async (id) => id === 's1' ? '/repo' : undefined,
      runGit: (args) => Promise.resolve(happyScript(args)),
    })
    await withServer(strict, async (port) => {
      const unknown = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/git?sessionId=ghost`)
      expect(unknown.status).toBe(404)
    })
  })

  it('happy path：status + tracked diff + untracked no-index 拼装', async () => {
    const handler = createGitGetHandler(deps)
    await withServer(handler, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/git?sessionId=s1`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.ok).toBe(true)
      expect(body.git).toBe(true)
      expect(body.branch).toBe('main')
      expect(body.status).toEqual([
        { x: ' ', y: 'M', path: 'a.ts' },
        { x: '?', y: '?', path: 'new.txt' },
      ])
      expect(body.diffText).toContain('-old\n+new')
      expect(body.diffText).toContain('+fresh')
      expect(body.truncated).toBe(false)
    })
  })

  it('非 git 目录返回 {git:false}；maxDiffBytes 触发 truncated', async () => {
    const notGit = createGitGetHandler({ resolveRoot: async () => '/x', runGit: async () => ({ code: 1, stdout: '' }) })
    await withServer(notGit, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/git?sessionId=s1`)
      expect(await res.json()).toEqual({ ok: true, git: false })
    })
    const capped = createGitGetHandler({ resolveRoot: async () => '/repo', runGit: (args) => Promise.resolve(happyScript(args)), maxDiffBytes: 10 })
    await withServer(capped, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/git?sessionId=s1`)
      const body = await res.json() as Record<string, unknown>
      expect(body.truncated).toBe(true)
    })
  })
})

describe('restore handler', () => {
  it('tracked 文件走 git restore 自 HEAD（撤销 staged+unstaged）', async () => {
    const feed = fakeRunGit((args) => {
      if (args[0] === 'status') return { code: 0, stdout: ' M a.ts\0' }
      return { code: 0, stdout: '' }
    })
    const handler = createRestoreHandler({ resolveRoot: async () => '/repo', runGit: feed.runGit })
    await withServer(handler, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', path: 'a.ts' }),
      })
      const body = await res.json() as Record<string, unknown>
      expect(res.status).toBe(200)
      expect(body.reverted).toBe('restored')
      expect(feed.calls.at(-1)).toEqual(['restore', '--source=HEAD', '--worktree', '--staged', '--', 'a.ts'])
    })
  })

  it('untracked 文件被删除；坏路径 400；status 外的 path 400', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-restore-'))
    await writeFile(join(root, 'new.txt'), 'draft')
    const feed = fakeRunGit(() => ({ code: 0, stdout: '?? new.txt\0' }))
    const handler = createRestoreHandler({ resolveRoot: async () => root, runGit: feed.runGit })
    await withServer(handler, async (port) => {
      const ok = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', path: 'new.txt' }),
      })
      expect(((await ok.json()) as Record<string, unknown>).reverted).toBe('deleted')

      const escape = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', path: '../outside.txt' }),
      })
      expect(escape.status).toBe(400)

      const ghost = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', path: 'never-existed.txt' }),
      })
      expect(((await ghost.json()) as Record<string, unknown>).error).toBe('not-in-status')
    })
  })

  it('坏 JSON 400；mock 断言可被 vi 调用（依赖注入可测性冒烟）', async () => {
    const runGit = vi.fn((_args: readonly string[]) => Promise.resolve<GitRunResult>({ code: 0, stdout: ' M a.ts\0' }))
    const handler = createRestoreHandler({ resolveRoot: async () => '/repo', runGit })
    await withServer(handler, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-desktop/review/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      })
      expect(res.status).toBe(400)
      expect(runGit).not.toHaveBeenCalled()
    })
  })
})

afterAll(() => { /* http servers closed in-place */ })
