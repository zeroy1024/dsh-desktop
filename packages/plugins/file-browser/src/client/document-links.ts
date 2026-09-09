/**
 * 文档预览的链接/图片 URL 分类与路径解析（纯函数，无 DOM 依赖；唯一
 * import 是 file-open.ts 的 absoluteFilePath，作绝对路径的规范化复检，
 * 同为纯函数、零 Node/DOM API，不破坏浏览器 bundle 边界）。
 *
 * 上游 `MarkdownText` 把相对与锚点 URL 一律拒绝（其 JSDoc 明示的契约，服务
 * 不可信聊天输出）。文档预览的语义相反：README 的相对图片、仓内链接与
 * 标题锚点是**一等公民**。本模块把消毒后 hast 里的 URL 分为四类：
 *
 * - `image`：img 的 src。绝对 http/https/data 原样；相对形态解析为可加载
 *   路径（工作区模式 = root 相对；外部文件模式 = 绝对），交 raw 路由供给。
 * - `anchor`：`#…` 片段。点击滚动到文档内同名标题（id 由 slugger 生成）。
 * - `document`：仓内/盘内相对链接。点击在 tab 内打开（复用页面层既有的
 *   工作区相对与外部绝对两个 key 域）。
 * - `external`：http/https/mailto 等绝对外链。原样 <a>，宿主安全策略把
 *   非应用内导航交给系统浏览器。
 *
 * 拒绝类（javascript: 等）在 sanitize 阶段已被剥离；分类器对无法安全解析
 * 的形态保守归 `blocked`，给渲染层一个确定的降级出口（img 显示 alt、
 * 链接显示惰性文本）。
 */

import { absoluteFilePath } from './file-open.ts'

/** 解析上下文：当前文件位置决定相对 URL 的基准与边界语义。 */
export type DocumentPathContext =
  | { kind: 'workspace'; baseDir: string }
  | { kind: 'external-file'; baseDir: string }

/** 把规范化路径拆成不可动的根与可折叠的段（POSIX /、盘符 C:/、UNC //server/share）。 */
function pathParts(path: string): { root: string; segments: string[] } {
  const drive = /^[A-Za-z]:\//u.exec(path)
  const unc = /^\/\/[^/]+\/[^/]+(?:\/|$)/u.exec(path)
  const root = drive?.[0] ?? (unc === null ? (path.startsWith('/') ? '/' : '') : `${unc[0].replace(/\/$/u, '')}/`)
  return { root, segments: path.slice(root.length).split('/').filter(Boolean) }
}

/**
 * 取文档所在目录，保留盘符与 UNC 根。
 * 输入本身已是根（`/`、`C:/`、`//server/share`；`//server/x.md` 的 `x.md`
 * 会被识别为共享名，同属裸共享根）或不含任何段时，没有父目录可言，返回
 * undefined——钉住「parent ≠ 自身」不变量。调用方按各自语义降级
 * （FilePreview 把根形态 key 降级为 ''；此类 key 实为目录，read 必 400
 * is-directory，该降级在渲染路径上不可达）。
 */
export function documentParent(path: string): string | undefined {
  const { root, segments } = pathParts(path)
  if (segments.length === 0) return undefined
  segments.pop()
  return root + segments.join('/')
}

/** URL 分类结果（image/document 的 path 是可直接投给 raw/read 路由的键）。 */
export type ClassifiedUrl =
  /**
   * 可加载图片。via 标明 src 的供给面：
   * `url` = 绝对/内联 URL（http/https/data，直接可加载）；
   * `workspace` = 会话 root 相对路径（raw 路由的 path 通道）；
   * `external-file` = 文件系统绝对路径（raw 路由的 abs 通道）。
   */
  | { kind: 'image'; src: string; via: 'url' | 'workspace' | 'external-file' }
  | { kind: 'anchor'; target: string }
  | { kind: 'document'; path: string; absolute: boolean; fragment?: string }
  | { kind: 'external'; href: string }
  | { kind: 'blocked' }

/** 外链协议白名单（与上游聊天侧同源的最小集 + tel/ftp 的无害跳转）。 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:'])

/** 拆片段：返回 [主体, 片段|undefined]。 */
function splitFragment(url: string): [string, string | undefined] {
  const hash = url.indexOf('#')
  if (hash < 0) return [url, undefined]
  return [url.slice(0, hash), url.slice(hash + 1)]
}

/** percent-decode，失败（畸形 % 序列）返回原值。 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 绝对/协议 URL 的形态判定（能 new URL 即有协议）。 */
function absoluteProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol
  } catch {
    return undefined
  }
}

/**
 * 把相对路径解析进当前文件所在目录（纯字符串层）。
 * 固定 POSIX /、Windows 盘符或 UNC 共享根，只折叠根以下的目录段。
 * 工作区相对路径以空根处理；任何越过根的 `..` 均拒绝。
 * @param baseDir - 上下文基准目录。
 * @param rel - 文档中书写的相对路径（已 percent-decode、去片段、去前导 `/`）。
 * @returns 解析后的路径（绝对或 root 相对，与 baseDir 同域）。返回 undefined
 *   的全部来源：rel 为空或含 `\`/NUL（入口预检）；`..` 越出根；段消化后
 *   无剩余（baseDir 即根且 rel 全为 `.`/`..`）；root 非空时 absoluteFilePath
 *   规范化复检拒绝——入参已被上述预检排除 `\`/NUL/`.`/`..`，该来源当前不可
 *   达，属纵深防御，与 file-open.ts 的拒绝规则仅此处一点耦合。
 */
export function resolveRelativePath(baseDir: string, rel: string): string | undefined {
  if (rel === '' || rel.includes('\\') || rel.includes('\0')) return undefined
  const { root, segments } = pathParts(baseDir)
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    if (segment.includes('\0')) return undefined
    segments.push(segment)
  }
  if (segments.length === 0) return undefined
  const resolved = root + segments.join('/')
  return root === '' ? resolved : absoluteFilePath(resolved)
}

/**
 * 分类 img 的 src。
 * @param src - 消毒后 hast 的 img src。
 * @param context - 当前文件位置。
 */
export function classifyImageSrc(src: string, context: DocumentPathContext): ClassifiedUrl {
  const trimmed = src.trim()
  if (trimmed === '') return { kind: 'blocked' }
  const protocol = absoluteProtocol(trimmed)
  if (protocol !== undefined) {
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'data:') {
      return { kind: 'image', src: trimmed, via: 'url' }
    }
    return { kind: 'blocked' }
  }
  if (trimmed.startsWith('#')) return { kind: 'blocked' }
  // 协议相对（//host/x）与 UNC 一律拒：img 没有"合法的双斜杠相对"语义。
  if (trimmed.startsWith('//')) return { kind: 'blocked' }
  if (trimmed.startsWith('/')) {
    if (context.kind !== 'workspace') return { kind: 'blocked' }
    const rel = resolveRelativePath('', decode(trimmed.slice(1)))
    return rel === undefined ? { kind: 'blocked' } : { kind: 'image', src: rel, via: 'workspace' }
  }
  const rel = resolveRelativePath(context.baseDir, decode(trimmed))
  if (rel === undefined) return { kind: 'blocked' }
  return context.kind === 'external-file'
    ? { kind: 'image', src: rel, via: 'external-file' }
    : { kind: 'image', src: rel, via: 'workspace' }
}

/**
 * 分类 a 的 href。
 * @param href - 消毒后 hast 的 a href。
 * @param context - 当前文件位置。
 */
export function classifyAnchorHref(href: string, context: DocumentPathContext): ClassifiedUrl {
  const trimmed = href.trim()
  if (trimmed === '') return { kind: 'blocked' }
  const protocol = absoluteProtocol(trimmed)
  if (protocol !== undefined) {
    return EXTERNAL_PROTOCOLS.has(protocol)
      ? { kind: 'external', href: trimmed }
      : { kind: 'blocked' }
  }
  const [body, fragment] = splitFragment(trimmed)
  if (body === '') {
    if (fragment === undefined || fragment === '') return { kind: 'blocked' }
    return { kind: 'anchor', target: decode(fragment) }
  }
  if (body.startsWith('//')) return { kind: 'blocked' }
  if (body.startsWith('/')) {
    if (context.kind !== 'workspace') return { kind: 'blocked' }
    const rel = resolveRelativePath('', decode(body.slice(1)))
    if (rel === undefined) return { kind: 'blocked' }
    return fragment === undefined
      ? { kind: 'document', path: rel, absolute: false }
      : { kind: 'document', path: rel, absolute: false, fragment: decode(fragment) }
  }
  const rel = resolveRelativePath(context.baseDir, decode(body))
  if (rel === undefined) return { kind: 'blocked' }
  const absolute = context.kind === 'external-file'
  return fragment === undefined
    ? { kind: 'document', path: rel, absolute }
    : { kind: 'document', path: rel, absolute, fragment: decode(fragment) }
}
