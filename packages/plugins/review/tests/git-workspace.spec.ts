import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitGetHandler, createRestoreHandler } from '../src/git-handler.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function repo(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-git-workspace-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), 'original\n')
  }
  execFileSync('git', ['-C', root, 'add', '--all'])
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture'])
  for (const file of files) await writeFile(join(root, file), `modified ${file}\n`)
  return root
}

async function request(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  body?: object,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as { port: number }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/?sessionId=test`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('real Git workspace boundaries', () => {
  it('restores only the literal selected filename, leaving other glob matches untouched', async () => {
    const root = await repo(['[ab].txt', 'a.txt', 'b.txt'])
    const result = await request(createRestoreHandler({ resolveRoot: () => root }), { sessionId: 'test', path: '[ab].txt' })
    expect(result).toEqual({ status: 200, body: { ok: true, reverted: 'restored' } })
    expect(await readFile(join(root, '[ab].txt'), 'utf8')).toBe('original\n')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('modified a.txt\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('modified b.txt\n')
  })

  it('uses the session directory for status, tracked restore and untracked deletion', async () => {
    const root = await repo(['outside.txt', 'sub/tracked.txt', 'sub/sub/tracked.txt'])
    await writeFile(join(root, 'sub/new.txt'), 'selected new\n')
    await writeFile(join(root, 'sub/sub/new.txt'), 'nested new\n')
    const resolveRoot = () => join(root, 'sub')
    const snapshot = await request(createGitGetHandler({ resolveRoot }))
    const status = snapshot.body.status as Array<{ path: string }>
    expect(status.map(entry => entry.path).toSorted()).toEqual(['new.txt', 'sub/new.txt', 'sub/tracked.txt', 'tracked.txt'])
    expect(snapshot.body.diffText).toContain('+selected new')
    expect(snapshot.body.diffText).not.toContain('outside.txt')
    expect(snapshot.body.truncated).toBe(false)

    const handler = createRestoreHandler({ resolveRoot })
    expect((await request(handler, { sessionId: 'test', path: 'tracked.txt' })).status).toBe(200)
    expect(await readFile(join(root, 'sub/tracked.txt'), 'utf8')).toBe('original\n')
    expect(await readFile(join(root, 'sub/sub/tracked.txt'), 'utf8')).toBe('modified sub/sub/tracked.txt\n')
    expect((await request(handler, { sessionId: 'test', path: 'new.txt' })).status).toBe(200)
    await expect(readFile(join(root, 'sub/new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'sub/sub/new.txt'), 'utf8')).toBe('nested new\n')
    expect((await request(handler, { sessionId: 'test', path: '../outside.txt' })).status).toBe(400)
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('modified outside.txt\n')
  })

  it('bounds untracked UTF-8 diffs by bytes and reports truncation', async () => {
    const root = await repo(['tracked.txt'])
    execFileSync('git', ['-C', root, 'restore', 'tracked.txt'])
    await writeFile(join(root, 'new.txt'), '你好'.repeat(100))
    const result = await request(createGitGetHandler({ resolveRoot: () => root, maxDiffBytes: 200 }))
    expect(Buffer.byteLength(result.body.diffText as string)).toBeLessThanOrEqual(200)
    expect(result.body.truncated).toBe(true)
    expect(result.body.diffText).not.toContain('\ufffd')
  })

  it('reads tracked and untracked diffs without invoking repository diff helpers', async () => {
    const root = await repo(['tracked.txt'])
    await writeFile(join(root, 'new.txt'), 'new file content\n')
    const helper = join(root, '.git', 'diff-helper.cjs')
    const marker = join(root, '.git', 'helper-invoked')
    await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called')\n`)
    // Git launches configured diff commands through its shell on all platforms.
    const command = `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`
    execFileSync('git', ['-C', root, 'config', 'diff.external', command])
    execFileSync('git', ['-C', root, 'config', 'diff.preview.textconv', command])
    await writeFile(join(root, '.git', 'info', 'attributes'), '*.txt diff=preview\n')
    const result = await request(createGitGetHandler({ resolveRoot: () => root }))
    expect(result.status).toBe(200)
    expect(result.body.diffText).toContain('+modified tracked.txt')
    expect(result.body.diffText).toContain('+new file content')
    expect(result.body.truncated).toBe(false)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
