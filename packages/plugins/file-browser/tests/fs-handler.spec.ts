/**
 * fs-handler 集成测：真 temp 目录 + 真 http server + fetch。
 * 覆盖信任栅栏、session 解析、路径沙箱、list/read 语义与 symlink 逃逸。
 * 这是仓库首个 node 半测试先例（此前插件 node 半全是空 apply）。
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFsHandler, FS_ROUTE_PREFIX } from '../src/fs-handler'

const trustedHeaders = { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9' }

let root: string
let outside: string
let server: ReturnType<typeof createServer>
let port = 0

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-fs-test-'))
  root = join(base, 'repo')
  outside = join(base, 'outside')
  await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
  await mkdir(join(root, 'src'))
  await mkdir(outside)
  await writeFile(join(root, 'README.md'), '# hello\n')
  await writeFile(join(root, 'apps', 'desktop', 'main.ts'), 'const x = 1\n')
  await writeFile(join(outside, 'secret.txt'), 'top secret')
  // root 内的 symlink 指到 root 外：list 跟随分类可见，但 read 必须被 realpath 拦下。
  await symlink(join(outside, 'secret.txt'), join(root, 'link-out'))
  await symlink(outside, join(root, 'dir-out'))

  const sessions = new Map<string, string | undefined>([
    ['s1', root],
    ['s2', undefined], // 有 session 无 cwd
  ])
  server = createServer(createFsHandler({
    // s3 走异步解析路径（镜像冷会话的落盘 header 查询形态）。
    resolveRoot: id => id === 's3' ? Promise.resolve(root) : sessions.get(id),
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  port = address.port
})

afterAll(async () => {
  server.close()
  await rm(join(root, '..'), { recursive: true, force: true })
})

/** 原始 http 请求：fetch 规范禁改 Host 头（undici 静默丢弃），栅栏测试必须直写。 */
function get(path: string, headers: Record<string, string> = trustedHeaders, method = 'GET') {
  return new Promise<{ status: number; body: unknown }>((resolvePromise, rejectPromise) => {
    const req = httpRequest({
      host: '127.0.0.1', port, method, path: `${FS_ROUTE_PREFIX}${path}`, headers,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode ?? 0,
          body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { return undefined } })(),
        })
      })
    })
    req.on('error', rejectPromise)
    req.end()
  })
}

describe('栅栏', () => {
  it('拒绝非 loopback Host 与异源 Origin', async () => {
    expect((await get('/list?sessionId=s1', { host: 'evil.example' })).status).toBe(403)
    expect((await get('/list?sessionId=s1', {
      host: '127.0.0.1:9', origin: 'http://evil.example',
    })).status).toBe(403)
  })

  it('拒绝未知 op 与非 GET', async () => {
    expect((await get('/delete?sessionId=s1')).status).toBe(404)
    expect((await get('/list?sessionId=s1', trustedHeaders, 'POST')).status).toBe(405)
  })

  it('session 缺失/未知/无 cwd → 404 session-not-found', async () => {
    expect((await get('/list')).body).toEqual({ ok: false, error: 'session-not-found' })
    expect((await get('/list?sessionId=nope')).body).toEqual({ ok: false, error: 'session-not-found' })
    expect((await get('/list?sessionId=s2')).body).toEqual({ ok: false, error: 'session-not-found' })
  })

  it('异步解析的 root（冷会话形态）与同步一致可用', async () => {
    const { status, body } = await get('/list?sessionId=s3&path=')
    expect(status).toBe(200)
    // 响应回带 realpath 后的 canonical root（macOS /var → /private/var）。
    expect((body as { root: string }).root).toBe(await realpath(root))
  })

  it('路径沙箱：绝对路径与 .. 段拒绝', async () => {
    expect((await get('/list?sessionId=s1&path=/etc')).body).toEqual({ ok: false, error: 'bad-path' })
    expect((await get('/read?sessionId=s1&path=../outside/secret.txt')).body)
      .toEqual({ ok: false, error: 'bad-path' })
  })
})

describe('list op', () => {
  it('根目录：文件夹优先 + 名序，含隐藏不滤', async () => {
    const { status, body } = await get('/list?sessionId=s1&path=')
    expect(status).toBe(200)
    const names = (body as { entries: Array<{ name: string }> }).entries.map(e => e.name)
    expect(names).toEqual(['apps', 'dir-out', 'src', 'link-out', 'README.md'])
    const kinds = (body as { entries: Array<{ kind: string }> }).entries.map(e => e.kind)
    expect(kinds).toEqual(['dir', 'dir', 'dir', 'file', 'file'])
    expect((body as { truncated: boolean }).truncated).toBe(false)
  })

  it('子层 relPath 逐级拼接', async () => {
    const body = (await get('/list?sessionId=s1&path=apps')).body as {
      entries: Array<{ relPath: string; name: string }>
    }
    expect(body.entries[0]).toMatchObject({ name: 'desktop', relPath: 'apps/desktop' })
  })

  it('不存在的路径 → 404 not-found；列文件当目录 → 400 bad-path', async () => {
    expect((await get('/list?sessionId=s1&path=nope')).body).toEqual({ ok: false, error: 'not-found' })
    expect((await get('/list?sessionId=s1&path=README.md')).body).toEqual({ ok: false, error: 'bad-path' })
  })
})

describe('read op', () => {
  it('文本文件回 text + size', async () => {
    const body = (await get('/read?sessionId=s1&path=README.md')).body as {
      ok: boolean; text?: string; size?: number
    }
    expect(body).toMatchObject({ ok: true, text: '# hello\n' })
    expect(body.size).toBe(8)
  })

  it('目录 → is-directory；缺失 → not-found', async () => {
    expect((await get('/read?sessionId=s1&path=src')).body).toEqual({ ok: false, error: 'is-directory' })
    expect((await get('/read?sessionId=s1&path=nope.txt')).body).toEqual({ ok: false, error: 'not-found' })
  })

  it('空文件可预览（不误判二进制）', async () => {
    await writeFile(join(root, 'empty.txt'), '')
    expect((await get('/read?sessionId=s1&path=empty.txt')).body).toMatchObject({ ok: true, text: '' })
  })

  it('symlink 指向 root 外 → 403 symlink-escape（文件与目录两种）', async () => {
    expect((await get('/read?sessionId=s1&path=link-out')).body).toEqual({ ok: false, error: 'symlink-escape' })
    expect((await get('/list?sessionId=s1&path=dir-out')).body).toEqual({ ok: false, error: 'symlink-escape' })
  })
})
