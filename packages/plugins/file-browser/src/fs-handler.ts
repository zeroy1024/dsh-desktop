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
 * 纵深防御：realpath 解析后仍对高敏感凭据目录（ssh/gnupg/aws/azure/
 * gh/kube/dsh 凭据库等）做前缀拒读（403 denied），避免渲染层 XSS/注入被
 * 放大成单 GET 凭据窃取——特性是"可读工作区外文件"，不是"可读任何文件"。
 *
 * 只读、限量：list 有界截断（maxEntries），read 大小短路（maxReadBytes）+
 * NUL 采样判二进制（前 8 KiB，与上游 fs-local 同法）。错误信封统一
 * {ok:false, error:<code>}，成功也带 ok:true——client 半不必区分 HTTP 码。
 */
import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
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
  | 'not-found' | 'is-directory' | 'symlink-escape' | 'denied' | 'unreadable'

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

/**
 * 高敏凭据路径 denylist 的条目（家目录相对；Windows 等价形态同表）。
 *
 * 只收"一看就是凭据"的形态——私钥、token、云凭据，不做宽泛隐私过滤。
 * 前缀语义：目录条目覆盖其全部后代；文件条目只拦自身（如 Claude Code 的
 * `.credentials.json` 与旧 LevelDB 形态 `.credentials` 是两处，需分别列出）。
 * 上游凭据布局（credentials-local）：`$DSH_HOME/.credentials.yaml`（受管凭据
 * 文档）+ `$DSH_HOME/.env`（回退 secrets 层），`$DSH_HOME` 默认 `~/.dsh`。
 */
const SENSITIVE_HOME_RELATIVES = [
  '.ssh', '.gnupg', '.aws', '.azure',
  '.config/gh', '.config/gcloud', '.kube',
  '.claude/.credentials', '.claude/.credentials.json', '.codex/auth.json',
  '.dsh/.credentials.yaml', '.dsh/.env',
] as const

/**
 * 由运行时基座派生的拒绝前缀（每次现算：os.homedir() / %USERPROFILE% /
 * $DSH_HOME 都是进程环境的事实，测试可 stub）。家目录基座恒收；%USERPROFILE%
 * 在真实 Windows 上与 os.homedir() 同源（去重后只留一份），被人为岔开时
 * （如测试 stub 了 homedir）两个基座都拦——deny 面只增不减。
 * 匹配走 canonicalRealPath 的小写盘符归一化形态。
 */
function deniedPrefixes(): Array<{ value: string; windows: boolean }> {
  const out: Array<{ value: string; windows: boolean }> = []
  const add = (base: { value: string; windows: boolean }): void => {
    for (const rel of SENSITIVE_HOME_RELATIVES) {
      out.push({ value: `${base.value}/${rel}`, windows: base.windows })
    }
  }
  const home = canonicalRealPath(homedir())
  if (home !== undefined) add(home)
  const profile = process.env.USERPROFILE
  if (profile !== undefined) {
    const canonical = canonicalRealPath(profile)
    if (canonical !== undefined && canonical.windows && canonical.value !== home?.value) {
      add(canonical)
    }
  }
  // $DSH_HOME 覆盖（上游 resolveDshHome：环境优先于 ~/.dsh）：凭据文档与
  // 回退 secrets 层同列，别被换根绕开。相对形态无法解析则跳过（兜底仍在）。
  const dshHome = process.env.DSH_HOME
  if (dshHome !== undefined && dshHome.trim() !== '') {
    const canonical = canonicalRealPath(dshHome)
    if (canonical !== undefined) {
      out.push({ value: `${canonical.value}/.credentials.yaml`, windows: canonical.windows })
      out.push({ value: `${canonical.value}/.env`, windows: canonical.windows })
    }
  }
  return out
}

/** 段边界的词法前缀判定：`a/b/c` 命中前缀 `a/b`，`a/bc` 不命中。 */
function isWithinPath(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * 前缀基座的 realpath 归一（async）：被读文件已解析到最终目标
 * （`~/.ssh` 若本身是 symlink 也要随之解析，否则词法比对会脱靶——
 * `/tmp` 别名 / 家目录软链等真实布局），realpath 失败按原值比对兜底。
 * 仅 server 端调用；纯函数判定（isDeniedAbsolutePath）走词法路径。
 */
async function resolvedPrefixes(): Promise<Array<{ value: string; windows: boolean }>> {
  return Promise.all(deniedPrefixes().map(async prefix => {
    try {
      const real = canonicalRealPath(await realpath(prefix.value))
      if (real !== undefined) return real
    } catch { /* 前缀目录尚不存在（含纯测试路径）：按词法值比对。 */ }
    return prefix
  }))
}

/**
 * abs 读端的高敏凭据路径判定（纯字符串，消费 realpath 之后的 canonical
 * 形态——symlink 先解析再判定，不给你换条链子绕过）。前缀在段边界匹配：
 * `~/.ssh/keys/x` 命中 `~/.ssh`，`~/.ssh2/x` 不命中；Windows 按
 * canonicalRealPath 折叠大小写，POSIX 严格区分。
 */
export function isDeniedAbsolutePath(absReal: string): boolean {
  const canonical = canonicalRealPath(absReal)
  if (canonical === undefined) return false
  for (const prefix of deniedPrefixes()) {
    if (prefix.windows !== canonical.windows) continue
    if (isWithinPath(prefix.value, canonical.value)) return true
  }
  return false
}

/**
 * async 版判定：**目标与前缀都过 realpath**（目标自身解析失败按词法值
 * 兜底），消除 `/var ↔ /private/var`、家目录软链等词法别名造成的漏判。
 * server 端（目标已解析）与直接调用（词法路径）行为一致。
 */
export async function isDeniedResolvedPath(absReal: string): Promise<boolean> {
  let target = absReal
  try {
    target = await realpath(absReal)
  } catch { /* 目标不存在等：按词法值比对，仍能拦前缀直命。 */ }
  const canonical = canonicalRealPath(target)
  if (canonical === undefined) return false
  const prefixes = await resolvedPrefixes()
  for (const prefix of prefixes) {
    if (prefix.windows !== canonical.windows) continue
    if (isWithinPath(prefix.value, canonical.value)) return true
  }
  return false
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
 * 纵深防御：realpath 之后再过高敏凭据 denylist（`isDeniedResolvedPath`，
 * 目标与前缀都取解析后形态），拦 `~/.ssh` 等凭据目录及其 symlink 别名
 * （渲染层 XSS 单 GET 窃取场景）。
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
  if (await isDeniedResolvedPath(absReal)) {
    sendJson(res, 403, { ok: false, error: 'denied' satisfies FsErrorCode })
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
