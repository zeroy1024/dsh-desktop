/**
 * fs-handler 集成测：真 temp 目录 + 真 http server + fetch。
 * 覆盖信任栅栏、session 解析、路径沙箱、list/read 语义、symlink 逃逸
 * 与 abs 通道的高敏凭据 denylist（homedir 经 vi.mock 控制基座）。
 * 这是仓库首个 node 半测试先例（此前插件 node 半全是空 apply）。
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFsHandler, FS_ROUTE_PREFIX, isDeniedAbsolutePath, isDeniedResolvedPath, normalizeAbsoluteInput } from '../src/fs-handler'

/**
 * 测试可控的家目录：`~/.ssh` 等 denylist 前缀由运行时 homedir() 派生，
 * stub 到临时目录即可断言，不碰真实 $HOME；默认回落真实 homedir()。
 */
const homeControl = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeControl.value ?? actual.homedir() }
})

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

/** abs 值需要 URL 编码（绝对路径含 `/`，Windows 盘符含 `:`）；两个 abs 用例共用。 */
function readAbs(abs: string, sessionId = 's1'): ReturnType<typeof get> {
  return get(`/read?sessionId=${sessionId}&abs=${encodeURIComponent(abs)}`)
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

describe('normalizeAbsoluteInput', () => {
  it('接受并规范化绝对形态（POSIX / UNC / Windows 盘符）', () => {
    expect(normalizeAbsoluteInput('/a/b.txt')).toBe('/a/b.txt')
    expect(normalizeAbsoluteInput('//a//b//c')).toBe('//a/b/c')
    expect(normalizeAbsoluteInput('C:\\Users\\z\\n.txt')).toBe('C:/Users/z/n.txt')
    expect(normalizeAbsoluteInput('C:/a')).toBe('C:/a')
    expect(normalizeAbsoluteInput('\\\\srv\\share')).toBe('//srv/share')
  })

  it('拒绝相对、穿越与畸形形态', () => {
    const bad = ['', '.', '..', 'rel/file', 'rel\\file', 'C:relative', '/a/../b',
      '/a/./b', '//a/../b', 'C:\\a\\..\\b', 'a\0b', '/a\0b']
    for (const input of bad) expect(normalizeAbsoluteInput(input)).toBeUndefined()
  })
})

describe('read op 工作区外单文件（abs）', () => {
  it('工作区外文件可预览（特性主路径）', async () => {
    const { status, body } = await readAbs(join(outside, 'secret.txt'))
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, text: 'top secret', size: 10 })
  })

  it('macOS tmp symlink（/var → /private/var）不误伤：realpath 后直接可读', async () => {
    // abs 通道无 root 边界，realpath 的临时目录别名不影响结果。
    const { body } = await readAbs(await realpath(join(outside, 'secret.txt')))
    expect(body).toMatchObject({ ok: true, text: 'top secret' })
  })

  it('外部目录 → is-directory；缺失 → not-found', async () => {
    expect((await readAbs(outside)).body).toEqual({ ok: false, error: 'is-directory' })
    expect((await readAbs(join(outside, 'nope.txt'))).body).toEqual({ ok: false, error: 'not-found' })
  })

  it('非法形态（相对/穿越）→ 400 bad-path', async () => {
    expect((await readAbs('secret.txt')).body).toEqual({ ok: false, error: 'bad-path' })
    // 手动拼接保留 `..` 段（path.join 会提前规范化，测不到服务端拒绝）。
    expect((await readAbs(`${root}/../outside/secret.txt`)).body)
      .toEqual({ ok: false, error: 'bad-path' })
  })

  it('list 不接受 abs（文件树仍锚定工作区）→ 400 bad-request', async () => {
    expect((await get(`/list?sessionId=s1&abs=${encodeURIComponent(join(outside, 'secret.txt'))}`)).body)
      .toEqual({ ok: false, error: 'bad-request' })
  })

  it('abs read 仍要求有效会话 → 404 session-not-found', async () => {
    expect((await readAbs(join(outside, 'secret.txt'), 'nope')).body)
      .toEqual({ ok: false, error: 'session-not-found' })
    expect((await readAbs(join(outside, 'secret.txt'), 's2')).body)
      .toEqual({ ok: false, error: 'session-not-found' })
  })
})

describe('abs 高敏凭据 denylist', () => {
  /** 与 beforeAll 同根的独立布局：denylist 目录 + 普通外部文件 + 绕道链。 */
  let credRoot: string
  let home: string
  let sshDir: string
  let bypass: string
  let plainDir: string

  beforeEach(async () => {
    // macOS /var → /private/var：先 realpath 再派生，基座与目录树同源，
    // 否则 denylist 前缀的 realpath 归一与词法 home 会对不上。
    credRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-fs-denied-')))
    home = join(credRoot, 'home')
    sshDir = join(home, '.ssh')
    bypass = join(credRoot, 'bypass')
    plainDir = join(credRoot, 'elsewhere')
    await mkdir(sshDir, { recursive: true })
    await mkdir(plainDir, { recursive: true })
    await writeFile(join(sshDir, 'id_rsa'), 'PRIVATE KEY\n')
    await mkdir(bypass)
    // 绕道链：绝对路径自身与 ~/.ssh 无关，realpath 后才落入 .ssh ——
    // 证明判定发生在 realpath 之后（服务端与 async 判定双端断言）。
    await symlink(sshDir, join(bypass, 'ssh-alias'))
    await writeFile(join(plainDir, 'notes.txt'), 'plain notes\n')
    homeControl.value = home
  })

  afterEach(async () => {
    homeControl.value = undefined
    vi.unstubAllEnvs()
    await rm(credRoot, { recursive: true, force: true })
  })

  it('homedir 基座：直接命中 .ssh 目录内 → 403 denied', async () => {
    const body = (await readAbs(join(sshDir, 'id_rsa'))).body
    expect(body).toEqual({ ok: false, error: 'denied' })
  })

  it('homedir 基座：.dsh 凭据文档与 .env 拒绝', async () => {
    const dsh = join(home, '.dsh')
    await mkdir(dsh)
    await writeFile(join(dsh, '.credentials.yaml'), 'version: 1\nDEEPSEEK_API_KEY: redacted\n')
    await writeFile(join(dsh, '.env'), 'DEEPSEEK_API_KEY=redacted\n')
    expect((await readAbs(join(dsh, '.credentials.yaml'))).body).toEqual({ ok: false, error: 'denied' })
    expect((await readAbs(join(dsh, '.env'))).body).toEqual({ ok: false, error: 'denied' })
  })

  it('前缀段边界匹配：同前缀不同段（.ssh2）不误伤', async () => {
    const sshTwo = join(home, '.ssh2')
    await mkdir(sshTwo)
    await writeFile(join(sshTwo, 'notes.txt'), 'not a key\n')
    const body = (await readAbs(join(sshTwo, 'notes.txt'))).body
    expect(body).toMatchObject({ ok: true, text: 'not a key\n' })
  })

  it('subpath 命中（.config/gh 目录内）→ 403 denied', async () => {
    const gh = join(home, '.config', 'gh')
    await mkdir(gh, { recursive: true })
    await writeFile(join(gh, 'hosts.yml'), 'oauth_token: redacted\n')
    const body = (await readAbs(join(gh, 'hosts.yml'))).body
    expect(body).toEqual({ ok: false, error: 'denied' })
  })

  it('symlink 解析进 .ssh → 403 denied（判定在 realpath 之后）', async () => {
    const viaBypass = join(bypass, 'ssh-alias', 'id_rsa')
    // 先 async 判定后 HTTP：同一 canonical 输入，行为必须一致。
    expect(await isDeniedResolvedPath(viaBypass)).toBe(true)
    expect(isDeniedAbsolutePath(viaBypass)).toBe(false) // 词法上确实不在 .ssh 下
    const { status, body } = await readAbs(viaBypass)
    expect(status).toBe(403)
    expect(body).toEqual({ ok: false, error: 'denied' })
  })

  it('denylist 外的工作区外文件仍可读（特性未收缩）', async () => {
    expect((await readAbs(join(plainDir, 'notes.txt'))).body).toMatchObject({
      ok: true, text: 'plain notes\n',
    })
  })

  it('Windows 盘符形态：homedir 基座下 C:/Users/me/.ssh/id_rsa 拒绝', () => {
    homeControl.value = 'C:\\Users\\me'
    expect(isDeniedAbsolutePath('C:/Users/me/.ssh/id_rsa')).toBe(true)
    expect(isDeniedAbsolutePath('C:/users/ME/.aws/credentials')).toBe(true)
    // 换盘符/非家目录基座不误伤；POSIX 形态不受 Windows 基座影响。
    expect(isDeniedAbsolutePath('D:/Users/me/.ssh/id_rsa')).toBe(false)
    expect(isDeniedAbsolutePath('/home/me/.ssh/id_rsa')).toBe(false)
  })

  it('USERPROFILE 与 homedir 岔开：两个基座都拦（真实 Windows 主机回归）', () => {
    // 真实 Windows 上 USERPROFILE 恒存在；此前实现只看 USERPROFILE、忽略
    // homedir 基座，导致 Windows CI 上 stub 的家目录整条失效。两个基座
    // 都应生效（deny 面只增不减），同名时实现侧去重。
    homeControl.value = 'C:\\Users\\me'
    vi.stubEnv('USERPROFILE', 'C:\\Users\\runneradmin')
    expect(isDeniedAbsolutePath('C:/Users/me/.ssh/id_rsa')).toBe(true)
    expect(isDeniedAbsolutePath('C:/Users/runneradmin/.aws/credentials')).toBe(true)
    expect(isDeniedAbsolutePath('C:/Users/other/.ssh/id_rsa')).toBe(false)
  })
})
