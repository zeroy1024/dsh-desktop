/**
 * git 数据面 handler（node 半）：worktree 改动源的只读 GET + 撤销 POST。
 *
 * 路由（挂在 agent webserver，命名空间避开上游未来路径）：
 *   GET  /dsh-desktop/review/git?sessionId=&scope=uncommitted
 *        → {ok, git:true, branch, status, diffText, truncated} | {ok, git:false}
 *   POST /dsh-desktop/review/restore  {sessionId, path}
 *        → {ok:true}（tracked = git restore 自 HEAD；untracked = 删除文件）
 *
 * 栅栏（顺序即优先级）：
 *   1. method → 405；
 *   2. bridge `isTrustedFsRequest`（Host loopback + sec-fetch-site + Origin
 *      同源）→ 403；
 *   3. root 由 sessionId 服务端解析（header.cwd → 落盘 header 兜底），
 *      未知会话 404。
 *
 * 只读纪律：GET 侧 git 命令全部白名单常量 argv（execFile 数组传参，无
 * shell、带 timeout/maxBuffer），不接受任何客户端拼接参数；POST restore
 * 是唯一的写路径——客户端 path 必须过 `resolveWithinRoot` 字符串沙箱，
 * 且按实时 status 分类（untracked 才允许删文件，tracked 走 git restore）。
 * 错误信封统一 {ok:false, error:<code>}。
 */
import { execFile } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedFsRequest, resolveWithinRoot } from '@dsh-desktop/bridge/fs-guard'
import { GIT_ROUTE, RESTORE_ROUTE, type GitStatusEntry } from './shared'

/** GET 路由前缀（index.ts 注册用）。 */
export { GIT_ROUTE }

/** 错误码表（信封 error 字段；HTTP 码只做粗分）：forbidden / bad-request /
 *  bad-path / session-not-found / not-in-status / git-error。 */

/** execFile 的结果投影（超时/被杀时 code 为 null）。 */
export interface GitRunResult {
  code: number | null
  stdout: string
}

/** handler 依赖注入面（apply 闭包提供 resolveRoot；测试注入假 runGit）。 */
export interface GitHandlerDeps {
  resolveRoot: (sessionId: string) => string | undefined | Promise<string | undefined>
  /** 默认实现 = execFile('git', ['-C', cwd, ...args])；测试注入假件。 */
  runGit?: (args: readonly string[], cwd: string) => Promise<GitRunResult>
  maxDiffBytes?: number
  maxUntracked?: number
  maxBodyBytes?: number
}

/** 统一 JSON 发送（no-store + 显式 charset + content-length）。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 读取并校验请求体（POST 专用；上限默认 4KB）。 */
async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBodyBytes) return undefined
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** 默认 git 执行器：数组 argv、无 shell、15s 超时 + 8MB 输出上限。 */
function defaultRunGit(args: readonly string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolveP) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // 超时/被杀时 error.code 可能是字符串（'ETIMEDOUT' 等），一律折算为 null。
        const rawCode = error === null ? 0 : (error as { code?: number | string }).code
        resolveP({ code: typeof rawCode === 'number' ? rawCode : null, stdout: typeof stdout === 'string' ? stdout : '' })
      },
    )
  })
}

/**
 * `git status --porcelain=v1 -z` 解析：NUL 分隔，条目 = XY<space>path；
 * X/Y 为 R/C 时后随第二个 NUL token 是原路径。
 */
export function parseStatusZ(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '') continue
    if (token.length < 4) continue
    const x = token[0] as string
    const y = token[1] as string
    const path = token.slice(3)
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    const oldPath = renamed ? tokens[++i] : undefined
    entries.push({ x, y, path, ...(oldPath === undefined ? {} : { oldPath }) })
  }
  return entries
}

/** status 条目是否未跟踪（全问号）。 */
function isUntracked(entry: GitStatusEntry): boolean {
  return entry.x === '?' && entry.y === '?'
}

/** Porcelain paths are repository-relative; our protocol is session-cwd-relative. */
async function readWorkspaceStatus(
  runGit: NonNullable<GitHandlerDeps['runGit']>,
  root: string,
): Promise<GitStatusEntry[] | undefined> {
  const prefix = await runGit(['rev-parse', '--show-prefix'], root)
  if (prefix.code !== 0) return undefined
  // Remove the command's newline, preserving whitespace in real directory names.
  const base = prefix.stdout.replace(/\r?\n$/u, '')
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], root)
  if (status.code !== 0) return undefined
  return parseStatusZ(status.stdout).flatMap(entry => {
    if (!entry.path.startsWith(base)) return []
    const path = entry.path.slice(base.length)
    if (path === '' || resolveWithinRoot(root, path) === undefined) return []
    const oldPath = entry.oldPath?.startsWith(base) === true ? entry.oldPath.slice(base.length) : undefined
    return [{ x: entry.x, y: entry.y, path, ...(oldPath === undefined ? {} : { oldPath }) }]
  })
}

/** Bound the encoded payload without splitting a UTF-8 code point. */
function clipBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  let end = Math.max(0, bytes)
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * GET handler 工厂：uncommitted scope = `git diff HEAD`（staged+unstaged 的
 * tracked 改动，带行号头）+ 逐个 untracked 的 `--no-index` 全新文件 diff
 * （数量/字节有界，超限置 truncated）。
 */
export function createGitGetHandler(deps: GitHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const runGit = deps.runGit ?? defaultRunGit
  const maxDiffBytes = deps.maxDiffBytes ?? 2 * 1024 * 1024
  const maxUntracked = deps.maxUntracked ?? 50
  return async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!isTrustedFsRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const root = await deps.resolveRoot(sessionId)
    if (root === undefined) {
      sendJson(res, 404, { ok: false, error: 'session-not-found' })
      return
    }
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], root)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      sendJson(res, 200, { ok: true, git: false })
      return
    }
    const status = await readWorkspaceStatus(runGit, root)
    if (status === undefined) {
      sendJson(res, 500, { ok: false, error: 'git-error' })
      return
    }
    const [branchRun, tracked] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root),
      runGit(['diff', 'HEAD', '--relative', '--no-ext-diff', '--no-textconv', '--', '.'], root),
    ])
    if (tracked.code !== 0) {
      sendJson(res, 500, { ok: false, error: 'git-error' })
      return
    }
    const trackedText = clipBytes(tracked.stdout, maxDiffBytes)
    let truncated = trackedText !== tracked.stdout
    const parts: string[] = [trackedText]
    let totalBytes = Buffer.byteLength(trackedText)
    const untracked = status.filter(isUntracked)
    for (const entry of untracked.slice(0, maxUntracked)) {
      if (totalBytes >= maxDiffBytes) {
        truncated = true
        break
      }
      // --no-index 以退出码 1 表达「有差异」——是预期路径，不算失败。
      const run = await runGit(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', entry.path], root)
      // A no-index operational failure may also return 1 with no diff output.
      if (run.code !== 0 && (run.code !== 1 || run.stdout === '')) {
        truncated = true
        continue
      }
      const text = clipBytes(run.stdout, maxDiffBytes - totalBytes)
      parts.push(text)
      totalBytes += Buffer.byteLength(text)
      if (text !== run.stdout) truncated = true
    }
    if (untracked.length > maxUntracked) truncated = true
    sendJson(res, 200, {
      ok: true,
      git: true,
      branch: branchRun.code === 0 ? branchRun.stdout.trim() : undefined,
      status,
      diffText: parts.join(''),
      truncated,
    })
  }
}

/**
 * POST restore handler 工厂：tracked 文件 `git restore --source=HEAD
 * --worktree --staged`（撤销该文件全部未提交修改，含 staged）；untracked
 * 文件直接删除。写路径三重防护：path 字符串沙箱（resolveWithinRoot）+
 * 按**实时 status** 分类（status 里不存在的 path 拒绝）+ 只对单文件操作。
 */
export function createRestoreHandler(deps: GitHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const runGit = deps.runGit ?? defaultRunGit
  const maxBodyBytes = deps.maxBodyBytes ?? 4096
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!isTrustedFsRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const body = await readJsonBody(req, maxBodyBytes)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const sessionId = body.sessionId
    const rawPath = body.path
    if (typeof sessionId !== 'string' || typeof rawPath !== 'string' || rawPath === '') {
      sendJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    const root = await deps.resolveRoot(sessionId)
    if (root === undefined) {
      sendJson(res, 404, { ok: false, error: 'session-not-found' })
      return
    }
    // 字符串沙箱：拒绝绝对路径 / .. / 反斜杠等一切越界形态，结果钉在 root 内。
    const absolutePath = resolveWithinRoot(root, rawPath)
    if (absolutePath === undefined) {
      sendJson(res, 400, { ok: false, error: 'bad-path' })
      return
    }
    const status = await readWorkspaceStatus(runGit, root)
    if (status === undefined) {
      sendJson(res, 500, { ok: false, error: 'git-error' })
      return
    }
    const entry = status.find(item => item.path === rawPath)
    if (entry === undefined) {
      sendJson(res, 400, { ok: false, error: 'not-in-status' })
      return
    }
    if (isUntracked(entry)) {
      // untracked 的「撤销」 = 删除该新文件；resolveWithinRoot 沙箱返回的已
      // 是 root 内绝对路径，直接 unlink，无需再拼 root。
      await unlink(absolutePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
      })
      sendJson(res, 200, { ok: true, reverted: 'deleted' })
      return
    }
    const restore = await runGit(
      ['--literal-pathspecs', 'restore', '--source=HEAD', '--worktree', '--staged', '--', rawPath],
      root,
    )
    if (restore.code !== 0) {
      sendJson(res, 500, { ok: false, error: 'git-error' })
      return
    }
    sendJson(res, 200, { ok: true, reverted: 'restored' })
  }
}

/** 组装 GET/POST 两条 exact 路由的注册面（index.ts 消费）。 */
export function createGitRoutes(deps: GitHandlerDeps): Array<{
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}> {
  return [
    { path: GIT_ROUTE, handler: createGitGetHandler(deps) },
    { path: RESTORE_ROUTE, handler: createRestoreHandler(deps) },
  ]
}
