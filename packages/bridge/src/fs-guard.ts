/**
 * 文件浏览只读数据面的两道纯函数栅栏（file-browser 插件 node 半消费）：
 *
 * 1. `isTrustedFsRequest` —— 仿上游 `/api` 的 Host/Origin 信任栅栏
 *    （upstream `client/connection/src/api-request-trust.ts`）的等价自写实现：
 *    上游函数在本仓不可 import（铁律 4：不依赖上游 src），且我们的 /fs 路由
 *    没有 trustedHosts 配置面（desktop 恒为 127.0.0.1 loopback），因此这里
 *    保留三条件最小形：Host 必须 loopback、sec-fetch-site 不得为 cross-site、
 *    带 Origin 时必须与 Host 同源（`null` 拒绝）。它挡的是 DNS rebinding 与
 *    恶意页面跨站读，不是鉴权层。
 * 2. `resolveWithinRoot` —— 工作区路径沙箱：把客户端传来的相对路径钉死在
 *    会话工作目录内，拒绝绝对路径、反斜杠、`.`/`..` 段与 normalize 后逃逸。
 *    root 同时支持 POSIX 绝对路径和 Windows 盘符绝对路径；客户端路径仍只
 *    接受 `/` 分隔的相对路径。纯字符串层判定（无 fs I/O）；symlink 逃逸由
 *    调用方在 fs 侧用 realpath 再校验一次（两道都过才放行）。
 */

/** 栅栏读取的请求事实：只需 headers（Node IncomingMessage 与 Fetch Request 均可提供）。 */
export interface GuardRequest {
  headers: Pick<Headers, 'get'> | Record<string, string | string[] | undefined>
}

/** Windows 盘符绝对路径（`C:\\repo` 与 `C:/repo`）；`C:repo` 是 drive-relative，必须拒绝。 */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/u
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u

/** 取头：兼容 `Headers` 与 Node `IncomingHttpHeaders` 两种表示；数组头视为不可辨认 → undefined。 */
function readHeader(headers: GuardRequest['headers'], name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined
  }
  const value = (headers as Record<string, string | string[] | undefined>)[name]
  return typeof value === 'string' ? value : undefined
}

/** Host 头的 WHATWG 规范化（http: 是 special scheme，解析失败返回 undefined）。 */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 规范化 hostname 是否 loopback（localhost / [::1] / 127/8 IPv4），与上游判定同语义。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * /fs 只读路由的信任栅栏。
 * @param request - 请求头事实。
 * @returns true 当且仅当 Host 是 loopback 且附带的浏览器标记同源于本站。
 */
export function isTrustedFsRequest(request: GuardRequest): boolean {
  // Host 栅栏先于一切：rebinding 页面带着攻击者域名请求、socket 却落到本机，
  // 此时 Origin/sec-fetch-site 可能双双缺席（普通 HTTP 读），Host 是唯一不可伪造的锚。
  const host = readHeader(request.headers, 'host')
  if (host === undefined) return false
  // WHATWG 解析会剥离 userinfo 与 path（`user@127.0.0.1`、`host:9/path` 解析后 hostname
  // 仍是 loopback）；合法 Host 头二者皆无，显式拒绝凭据/路径形态。
  if (host.includes('@') || host.includes('/')) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  // 跨站标记直接拒绝（现代浏览器对每个 fetch 都带）。
  if (readHeader(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin 栅栏：缺席放行（Host 已约束）；"null" 不透明源拒绝；存在则必须逐 host 相等。
  const origin = readHeader(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 把相对路径解析进 root 内（纯字符串层，不含 symlink 校验）。
 * @param root - 会话工作目录的绝对路径（POSIX 或 Windows 盘符；调用方保证已规范化）。
 * @param rel - 客户端传来的相对路径；空串表示 root 本身。
 * @returns root 内的绝对路径；非法输入返回 undefined。
 */
export function resolveWithinRoot(root: string, rel: string): string | undefined {
  const rootNorm = normalizeRoot(root)
  if (rootNorm === undefined) return undefined
  // 反斜杠在 Windows 上也是路径分隔，一律拒绝以免语义歧义。
  if (rel.includes('\0') || rel.includes('\\')) return undefined
  // 绝对路径与带盘符的形态一律拒绝：数据面只接受相对 root 的路径。
  // `C:foo` 虽不是绝对路径，但在 Windows 上是相对于 C: 当前目录的
  // drive-relative 语义；把它当普通文件名会引入跨盘符歧义，因此也拒绝。
  if (rel.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(rel)) return undefined
  // 逐段拒绝 `.`/`..`：即便 normalize 后仍落在 root 内，也不给相对跳转任何机会。
  for (const segment of rel.split('/')) {
    if (segment === '..' || segment === '.') return undefined
    if (segment.includes('\0')) return undefined
  }
  // root 自身先折叠（剥尾斜杠归一到 `/`）：`/repo/` 与 `/repo` 视为同一个 root。
  const joined = rel.length === 0 ? rootNorm : `${rootNorm}/${rel}`
  // 规范化折叠（消掉 `a//b` 之类），再确认没有意外越界（纵深防御）。
  const normalized = normalizePath(joined)
  const boundary = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`
  if (normalized !== rootNorm && !normalized.startsWith(boundary)) return undefined
  return normalized
}

/**
 * 规范化 root；同时理解 POSIX `/repo` 和 Windows `C:\\repo`。
 * 不展开 `.`/`..`（root 由调用方保证已规范化，rel 则在上面显式拒绝）。
 */
function normalizeRoot(root: string): string | undefined {
  if (root === '' || root.includes('\0')) return undefined
  if (WINDOWS_DRIVE_ROOT.test(root)) {
    // 统一成 Node 在 Windows 上也接受的 `/` 分隔，避免后续拼接混用两种
    // 分隔符；盘符后的根斜杠必须保留（否则会退化成 drive-relative `C:`）。
    const slashRoot = root.replaceAll('\\', '/')
    return normalizePath(`${slashRoot.slice(0, 2)}/${slashRoot.slice(2)}`)
  }
  if (!root.startsWith('/')) return undefined
  return normalizePath(root)
}

/** POSIX/drive-root 风格路径折叠（处理重复分隔符与尾分隔符）。 */
function normalizePath(path: string): string {
  const drive = /^([A-Za-z]):\//u.exec(path)
  if (drive !== null) {
    const segments = path.slice(2).split('/').filter(segment => segment !== '')
    return segments.length === 0
      ? `${drive[1]}:/`
      : `${drive[1]}:/${segments.join('/')}`
  }
  const segments = path.split('/').filter(segment => segment !== '')
  return path.startsWith('/')
    ? (segments.length === 0 ? '/' : `/${segments.join('/')}`)
    : segments.join('/')
}
