/**
 * file-browser 数据面 handler：两条只读路由的共享实现（node 半）。
 *
 * 路由挂在 agent webserver 的 prefix `/dsh-file-browser` 下（exact/prefix 表
 * 先于 SPA fallback，命名空间避开上游未来路径）：
 *   GET /dsh-file-browser/list?sessionId=&path=  → {ok, entries, truncated}
 *   GET /dsh-file-browser/read?sessionId=&path=  → {ok, text} | {ok, tooLarge|binary}
 *
 * 三道栅栏（顺序即优先级）：
 *   1. Host/Origin 信任栅栏（bridge `isTrustedFsRequest`）→ 403；
 *   2. 根目录由 **sessionId 服务端解析**（session header cwd，store 校验过
 *      绝对路径），客户端传的 path 一律视为 root 相对 → `resolveWithinRoot`
 *      字符串层沙箱 → 400；
 *   3. symlink 逃逸：realpath(root) 与 realpath(target) 再前缀比较 → 403。
 *
 * 工作区外单文件预览（read 专属）：`abs=<绝对路径>` 参数承载工作区外的
 * 规范化绝对路径（POSIX / Windows 盘符 / UNC），跳过栅栏 2/3 的 root 边界
 * ——特性即"可读工作区外文件"。信任锚不变：仍要求有效会话 + 信任栅栏 +
 * 大小/二进制限量；list 不接受 abs（文件树仍严格锚定会话工作区）。
 *
 * 只读、限量：list 有界截断（maxEntries），read 大小短路（maxReadBytes）+
 * NUL 采样判二进制（前 8 KiB，与上游 fs-local 同法）。错误信封统一
 * {ok:false, error:<code>}，成功也带 ok:true——client 半不必区分 HTTP 码。
 */
import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedFsRequest, resolveWithinRoot } from '@dsh-desktop/bridge/fs-guard'

/** 路由前缀；与 `index.ts` 的注册共用。 */
export const FS_ROUTE_PREFIX = '/dsh-file-browser'

/** 单次列目录返回上限（超出置 truncated；对齐上游 directory-picker 的有界窗口思想）。 */
export const DEFAULT_MAX_ENTRIES = 2000

/** 预览读取的字节上限（超限只回元信息，不吐内容）。 */
export const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024

/** NUL 采样窗口：前 8 KiB 含 0 字节即判二进制（上游 fs-local BINARY_SAMPLE_BYTES 同值）。 */
const BINARY_SAMPLE_BYTES = 8192

/** 列目录/读文件共用的条目投影。 */
export interface FsEntry {
  name: string
  /** 相对会话 root 的 POSIX 路径（树节点 key 与面包屑还原用）。 */
  relPath: string
  kind: 'dir' | 'file'
  /** 文件字节数；目录省略。stat 失败时省略（不阻断列表）。 */
  size?: number
}

/** handler 依赖注入面（apply 闭包提供 resolveRoot；测试可整体 mock）。 */
export interface FsHandlerDeps {
  /**
   * sessionId → 会话工作目录（绝对路径）；未知/无 cwd 返回 undefined。
   * 允许异步（冷会话要查落盘 header）。
   */
  resolveRoot: (sessionId: string) => string | undefined | Promise<string | undefined>
  maxEntries?: number
  maxReadBytes?: number
}

/** fs 错误信封的码表：client 半按 code 出文案。 */
type FsErrorCode =
  | 'forbidden' | 'bad-request' | 'bad-path' | 'session-not-found'
  | 'not-found' | 'is-directory' | 'symlink-escape' | 'unreadable'

/** 统一 JSON 发送：no-store（本地文件随时可改），charset 显式。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 断连竞速：请求已 abort 时抛哨兵，调用方静默收尾。 */
class AbortedError extends Error {}

/**
 * 响应侧取消信号：Node 的 IncomingMessage 不带 signal（那是 Fetch Request 的
 * 面），故从 `res` 的 close 事件构造——响应未写完即关闭 = 客户端断连，
 * 后续 fs 等待直接放弃。
 */
function responseSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  return controller.signal
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) throw new AbortedError()
  if (signal === undefined) return promise
  return new Promise<T>((resolveP, rejectP) => {
    const onAbort = (): void => rejectP(new AbortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolveP, rejectP).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** ENOENT/ENOTDIR 等 fs 错误 → 业务码；其余归 unreadable。 */
function fsErrorCode(err: unknown): FsErrorCode {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'not-found'
  if (code === 'EISDIR') return 'is-directory'
  // ENOTDIR：list 打到了文件上——路径形态不对，而非内容不可读。
  if (code === 'ENOTDIR') return 'bad-path'
  return 'unreadable'
}

/**
 * realpath 的比较形式。Node 在 Windows 上通常返回反斜杠路径，而
 * resolveWithinRoot 为了协议稳定会返回 `/` 分隔路径；比较前统一分隔符，
 * 并对 Windows 盘符/UNC 路径做大小写折叠（Windows 文件系统大小写不敏感）。
 */
function canonicalRealPath(path: string): { value: string; windows: boolean } | undefined {
  const drive = /^([A-Za-z]):[\\/]/u.exec(path)
  if (drive !== null) {
    const segments = path.slice(2).replaceAll('\\', '/').split('/').filter(Boolean)
    return {
      value: `${drive[1]}:/${segments.join('/')}`.toLowerCase(),
      windows: true,
    }
  }
  // Keep UNC support symmetrical with drive paths. A POSIX realpath normally
  // collapses a leading `//`, so this branch only applies to an actual UNC root.
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    const segments = path.replaceAll('\\', '/').split('/').filter(Boolean)
    return { value: `//${segments.join('/')}`.toLowerCase(), windows: true }
  }
  if (!path.startsWith('/')) return undefined
  const segments = path.split('/').filter(Boolean)
  return {
    value: segments.length === 0 ? '/' : `/${segments.join('/')}`,
    windows: false,
  }
}

/** 目标是否仍在 root 的 realpath 内（symlink 逃逸校验；调用方已拿 rootReal）。 */
function withinReal(rootReal: string, real: string): boolean {
  const root = canonicalRealPath(rootReal)
  const target = canonicalRealPath(real)
  if (root === undefined || target === undefined || root.windows !== target.windows) return false
  const boundary = root.value.endsWith('/') ? root.value : `${root.value}/`
  return target.value === root.value || target.value.startsWith(boundary)
}

/**
 * 工作区外预览的客户端绝对路径白盒化（纯字符串层，无 fs I/O）。
 *
 * 只接受明确的绝对形态：POSIX `/...`、UNC `//server/share`、Windows 盘符
 * `X:/...`（反斜杠统一折叠为 `/`，与 resolveWithinRoot 的协议稳定取向一致）。
 * 相对形态、`./`、`../` 段与 NUL 一律拒绝——外部路径没有 root 锚点做二次
 * 边界校验， therefore 在字符串层就不给任何"相对游走"的机会。
 * @returns 统一 `/` 分隔的规范化绝对路径；非法输入返回 undefined。
 */
export function normalizeAbsoluteInput(input: string): string | undefined {
  if (input === '' || input.includes('\0')) return undefined
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(input)
  let slashForm: string | undefined
  if (drive !== null) {
    slashForm = `${drive[1]}:/${drive[2].replaceAll('\\', '/')}`
  } else if (input.startsWith('\\\\') || input.startsWith('//')) {
    slashForm = `//${input.slice(2).replaceAll('\\', '/')}`
  } else if (input.startsWith('/')) {
    slashForm = input
  }
  if (slashForm === undefined) return undefined
  // 折叠重复分隔符后逐段拒绝 `.`/`..`：与 root 相对沙箱同强度。
  const segments = slashForm.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '.' || segment === '..')) return undefined
  if (drive !== null) return `${drive[1]}:/${segments.slice(1).join('/')}`
  return slashForm.startsWith('//')
    ? `//${segments.join('/')}`
    : `/${segments.join('/')}`
}

/** dirent → 条目：dir/file 分类，symlink 跟随 stat 判真实类型（断链归 file）。 */
async function entryOf(
  parentRel: string,
  dirent: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
  absPath: string,
): Promise<FsEntry> {
  const relPath = parentRel.length === 0 ? dirent.name : `${parentRel}/${dirent.name}`
  let kind: 'dir' | 'file'
  if (dirent.isDirectory()) kind = 'dir'
  else if (dirent.isFile()) kind = 'file'
  else {
    // symlink/其它：stat 跟随；读不到（断链）当 file 展示，点开自然 404。
    try {
      kind = (await stat(absPath)).isDirectory() ? 'dir' : 'file'
    } catch {
      kind = 'file'
    }
  }
  const entry: FsEntry = { name: dirent.name, relPath, kind }
  if (kind === 'file') {
    // size 尽力而为：目录巨量时失败也只是一个条目缺字段，不阻断整个列表。
    try {
      entry.size = (await stat(absPath)).size
    } catch { /* 省略 size */ }
  }
  return entry
}

/** list op：列目录（含文件），文件夹优先 + localeCompare 名序，有界截断。 */
async function handleList(
  res: ServerResponse,
  deps: FsHandlerDeps,
  root: string,
  rel: string,
  abs: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
  const rootReal = await raceAbort(realpath(root), signal)
  let absReal: string
  try {
    absReal = await raceAbort(realpath(abs), signal)
  } catch (err) {
    if (err instanceof AbortedError) return
    const code = fsErrorCode(err)
    sendJson(res, code === 'not-found' ? 404 : 500, { ok: false, error: code })
    return
  }
  if (!withinReal(rootReal, absReal)) {
    sendJson(res, 403, { ok: false, error: 'symlink-escape' satisfies FsErrorCode })
    return
  }
  let handle: import('node:fs').Dir
  try {
    handle = await raceAbort(opendir(absReal), signal)
  } catch (err) {
    if (err instanceof AbortedError) return
    const code = fsErrorCode(err)
    sendJson(res, code === 'not-found' ? 404 : 400, { ok: false, error: code })
    return
  }
  const dirents: import('node:fs').Dirent[] = []
  try {
    for await (const dirent of handle) {
      if (dirents.length >= maxEntries + 1) break
      dirents.push(dirent)
    }
  } catch (err) {
    if (err instanceof AbortedError) return
    sendJson(res, 500, { ok: false, error: 'unreadable' satisfies FsErrorCode })
    return
  } finally {
    await handle.close().catch(() => undefined)
  }
  const truncated = dirents.length > maxEntries
  const kept = truncated ? dirents.slice(0, maxEntries) : dirents
  const entries: FsEntry[] = []
  for (const dirent of kept) {
    const name = dirent.name
    const childAbs = `${absReal}/${name}`
    entries.push(await raceAbort(entryOf(rel, dirent, childAbs), signal))
  }
  // 文件夹优先，其后按名 localeCompare（与 Codex 树序一致）；隐藏文件不滤。
  entries.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    || a.name.localeCompare(b.name, undefined, { numeric: true }))
  // root 回带 canonical 值：client 拼绝对路径给 host.openPath 用，与服务端
  // 沙箱同一锚点，避免 workspace 注册表与 session cwd 的 realpath 偏差。
  sendJson(res, 200, { ok: true, root: rootReal, entries, truncated })
}

/** read op 的共享主体：边界校验（含 symlink 防逃逸）之后的内容投递。 */
async function readFilePayload(
  res: ServerResponse,
  deps: FsHandlerDeps,
  absReal: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const maxBytes = deps.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
  let info
  try {
    info = await raceAbort(stat(absReal), signal)
  } catch (err) {
    if (err instanceof AbortedError) return
    sendJson(res, 404, { ok: false, error: fsErrorCode(err) })
    return
  }
  if (info.isDirectory()) {
    sendJson(res, 400, { ok: false, error: 'is-directory' satisfies FsErrorCode })
    return
  }
  if (info.size > maxBytes) {
    // 超限：只回元信息，预览端出「文件过大」文案（对齐视频的大文件降级）。
    sendJson(res, 200, { ok: true, tooLarge: true, size: info.size })
    return
  }
  let buffer: Buffer
  try {
    buffer = await raceAbort(readFile(absReal), signal)
  } catch (err) {
    sendJson(res, 500, { ok: false, error: fsErrorCode(err) })
    return
  }
  const sampleEnd = Math.min(buffer.length, BINARY_SAMPLE_BYTES)
  if (buffer.subarray(0, sampleEnd).includes(0)) {
    sendJson(res, 200, { ok: true, binary: true, size: info.size })
    return
  }
  sendJson(res, 200, { ok: true, text: buffer.toString('utf8'), size: info.size })
}

/** read op（root 内）：root 相对沙箱 + symlink 逃逸校验后投递。 */
async function handleRead(
  res: ServerResponse,
  deps: FsHandlerDeps,
  root: string,
  abs: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rootReal = await raceAbort(realpath(root), signal)
  let absReal: string
  try {
    absReal = await raceAbort(realpath(abs), signal)
  } catch (err) {
    if (err instanceof AbortedError) return
    sendJson(res, 404, { ok: false, error: fsErrorCode(err) })
    return
  }
  if (!withinReal(rootReal, absReal)) {
    sendJson(res, 403, { ok: false, error: 'symlink-escape' satisfies FsErrorCode })
    return
  }
  await readFilePayload(res, deps, absReal, signal)
}

/**
 * read op（工作区外单文件）：`abs` 参数承载规范化绝对路径。无 root 边界
 * 可言（特性本身），symlink 逃逸校验不适用——realpath 解析后的最终目标
 * 就是读取对象；信任锚降为：有效会话 + 信任栅栏 + 大小/二进制限量。
 */
async function handleReadAbsolute(
  res: ServerResponse,
  deps: FsHandlerDeps,
  abs: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  let absReal: string
  try {
    absReal = await raceAbort(realpath(abs), signal)
  } catch (err) {
    if (err instanceof AbortedError) return
    sendJson(res, 404, { ok: false, error: fsErrorCode(err) })
    return
  }
  await readFilePayload(res, deps, absReal, signal)
}

/**
 * 构造 prefix 路由 handler（webserver 的 (req,res) 形状）。
 * 路由外的一切校验失败都收敛为 JSON 信封 + 恰当 HTTP 码。
 */
export function createFsHandler(deps: FsHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (!isTrustedFsRequest({ headers: req.headers })) {
        sendJson(res, 403, { ok: false, error: 'forbidden' satisfies FsErrorCode })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'bad-request' satisfies FsErrorCode })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const op = url.pathname.slice(FS_ROUTE_PREFIX.length + 1)
      if (op !== 'list' && op !== 'read') {
        sendJson(res, 404, { ok: false, error: 'bad-request' satisfies FsErrorCode })
        return
      }
      const sessionId = url.searchParams.get('sessionId')
      const rel = url.searchParams.get('path') ?? ''
      const absParam = url.searchParams.get('abs')
      if (sessionId === null || sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'session-not-found' satisfies FsErrorCode })
        return
      }
      const root = await deps.resolveRoot(sessionId)
      if (root === undefined) {
        sendJson(res, 404, { ok: false, error: 'session-not-found' satisfies FsErrorCode })
        return
      }
      const signal = responseSignal(res)
      if (absParam !== null) {
        // 工作区外单文件预览：仅 read；list 的 abs 一律拒绝（树仍锚定工作区）。
        if (op !== 'read') {
          sendJson(res, 400, { ok: false, error: 'bad-request' satisfies FsErrorCode })
          return
        }
        const target = normalizeAbsoluteInput(absParam)
        if (target === undefined) {
          sendJson(res, 400, { ok: false, error: 'bad-path' satisfies FsErrorCode })
          return
        }
        await handleReadAbsolute(res, deps, target, signal)
        return
      }
      const abs = resolveWithinRoot(root, rel)
      if (abs === undefined) {
        sendJson(res, 400, { ok: false, error: 'bad-path' satisfies FsErrorCode })
        return
      }
      if (op === 'list') await handleList(res, deps, root, rel, abs, signal)
      else await handleRead(res, deps, root, abs, signal)
    } catch (err) {
      if (err instanceof AbortedError) return // 客户端断连：静默。
      // 兜底：路由抛错不得击穿 webserver（其默认 400 无信封）。
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'unreadable' satisfies FsErrorCode })
      else res.end()
    }
  }
}
