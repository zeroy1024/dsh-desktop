/**
 * hast → 渲染描述符（纯函数层，无 React/DOM 依赖）。
 *
 * 分两层的理由：消毒后的 hast 已经安全，但"README 文档语义"的增值处理
 * （标题锚点 id、相对图片改写、仓内链接拦截、fenced code 交给 CodeBlock、
 * 任务清单 checkbox）全是可判定的纯映射。把它们停在描述符层，单测不需要
 * jsdom 与 React 运行时；`MarkdownDocument.tsx` 只做 createElement 与事件绑定。
 *
 * 描述符的 `action` 字段是渲染层与页面层的唯一交互面：
 * - `scroll`：文档内锚点，滚到目标 id；
 * - `open`：仓内/盘内链接，交页面层在 tab 内打开（可带片段）；
 * - 其余外链保留 `href`，宿主安全策略负责送系统浏览器。
 */
import GithubSlugger from 'github-slugger'
import type { Element, ElementContent, Nodes, Root, Text } from 'hast'
import { classifyAnchorHref, classifyImageSrc } from './document-links.ts'
import type { DocumentPathContext } from './document-links.ts'

/** 一个可渲染节点：tag + props + children；children 里字符串是纯文本。 */
export interface HastDescriptor {
  /** React key（文档序路径，稳定且免碰撞）。 */
  key: string
  /** 标签名；`codeblock` 是伪标签，由渲染层映射到 CodeBlock。 */
  tag: string
  props: Record<string, unknown>
  children: Array<HastDescriptor | string>
  /** 交互语义（仅 a 类节点产生）。 */
  action?: HastAction
}

/** 渲染层需要绑定的交互。 */
export type HastAction =
  | { kind: 'scroll'; target: string }
  /** relKey 复用页面层 tab 的两个 key 域：工作区相对路径或规范化绝对路径。 */
  | { kind: 'open'; relKey: string; fragment?: string }

/** 纯函数层的输入：文件位置 + 图片 URL 构造器。 */
export type DocumentRenderContext = DocumentPathContext & {
  /** 分类器给出的图片 src（root 相对 / 文件系统绝对）→ 可加载 URL。 */
  imageSrcFor: (src: string, via: 'workspace' | 'external-file') => string
}

/** 无脚本语义的空元素（children 必须为空）。 */
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'col', 'source', 'wbr', 'track'])

/** 属性名 → React 需要布尔化的属性。 */
const BOOLEAN_ATTRIBUTES = new Set(['open', 'checked', 'disabled', 'readonly', 'multiple', 'selected'])

/** 元素文本投影（标题 slug 与脚注标签用）。 */
function textOf(node: Nodes): string {
  if (node.type === 'text') return (node as Text).value
  if ('children' in node) return (node as { children: ElementContent[] }).children.map(textOf).join('')
  return ''
}

/**
 * 把 hast 属性表转成 React props。
 * - `className` 数组折叠为字符串（sanitize 产出数组）；
 * - 布尔属性归一（false 不写，避免 React 对 `open={false}` 产生与语义无关的
 *   属性存在性差异）；
 * - 数字/字符串原样透传（mdast-util-to-hast 已用 property 名，React 兼容）。
 */
function propsOf(properties: Element['properties']): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(properties)) {
    if (value === false || value === null || value === undefined) continue
    if (name === 'className') {
      const names = Array.isArray(value) ? value : [value]
      const joined = names.filter(entry => typeof entry === 'string' && entry !== '').join(' ')
      if (joined !== '') props.className = joined
      continue
    }
    if (BOOLEAN_ATTRIBUTES.has(name.toLowerCase())) {
      if (value === true) props[name] = true
      continue
    }
    // style 不在消毒 schema 白名单内；出现即异常，丢弃而不是透传。
    if (name === 'style') continue
    props[name] = value
  }
  return props
}

/** fenced code：`pre > code[className=language-x]` → CodeBlock 伪节点。 */
function codeBlockOf(node: Element, key: string): HastDescriptor | null {
  const elements = node.children.filter(child => child.type === 'element')
  if (elements.length !== 1) return null
  const [only] = elements
  if (only === undefined || only.type !== 'element' || only.tagName !== 'code') return null
  const classNames = (only.properties.className ?? []) as string[]
  const lang = classNames.find(name => name.startsWith('language-'))?.slice('language-'.length)
  return {
    key,
    tag: 'codeblock',
    props: { code: textOf(only), lang: lang === undefined || lang === '' ? undefined : lang },
    children: [],
  }
}

/** img：分类 src，改写为可加载 URL；被拒时降级为 alt 文本。 */
function imageOf(node: Element, key: string, context: DocumentRenderContext): HastDescriptor {
  const src = typeof node.properties.src === 'string' ? node.properties.src : ''
  const alt = typeof node.properties.alt === 'string' ? node.properties.alt : ''
  const classified = classifyImageSrc(src, context)
  if (classified.kind !== 'image') {
    // 与上游聊天侧同策：不可加载时显示 alt（斜体样式由 CSS 承担）。
    return { key, tag: 'span', props: { className: 'fb-image-alt' }, children: [alt] }
  }
  const resolved = classified.via === 'url'
    ? classified.src
    : context.imageSrcFor(classified.src, classified.via)
  // 消毒后的 width/height/align 等透传（README 徽章的尺寸声明依赖它们）。
  const props = propsOf(node.properties)
  return {
    key,
    tag: 'img',
    props: { ...props, src: resolved, alt, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' },
    children: [],
  }
}

/** a：分类 href → 锚点滚动 / 文档打开 / 外链 / 降级惰性文本。 */
function anchorOf(
  node: Element,
  key: string,
  context: DocumentRenderContext,
  walk: (children: ElementContent[], key: string) => Array<HastDescriptor | string>,
): HastDescriptor {
  const children = walk(node.children, key)
  const href = typeof node.properties.href === 'string' ? node.properties.href : ''
  const props = propsOf(node.properties)
  delete props.href
  if (href === '') {
    // 无 href 的 <a>（或 href 被消毒剥离）：GitHub 同样渲染为惰性文本。
    return { key, tag: 'span', props, children }
  }
  const classified = classifyAnchorHref(href, context)
  switch (classified.kind) {
    case 'anchor':
      return { key, tag: 'a', props: { ...props, href: `#${classified.target}` }, children, action: { kind: 'scroll', target: classified.target } }
    case 'document':
      // href 保留书写形态仅供悬停预览；点击被 action 拦截，不发生真实导航。
      return { key, tag: 'a', props: { ...props, href: `#doc:${encodeURIComponent(classified.path)}` }, children, action: { kind: 'open', relKey: classified.path, fragment: classified.fragment } }
    case 'external':
      return { key, tag: 'a', props: { ...props, href: classified.href, target: '_blank', rel: 'noopener noreferrer' }, children }
    default:
      // 'blocked'（及分类器未来新增的拒绝态）：惰性文本，与无 href 同策。
      return { key, tag: 'span', props, children }
  }
}

/**
 * 把消毒后的 hast 树映射为描述符树。
 * @param root - `markdownToSafeHast` 的产物。
 * @param context - 文件位置与图片 URL 构造器。
 * @returns 顶层描述符列表（标题按文档序生成锚点 id）。
 */
export function hastToDescriptors(root: Root, context: DocumentRenderContext): Array<HastDescriptor | string> {
  // slugger 与文档序绑定：标题的可见顺序决定去重后缀（`x`、`x-1`…），
  // 遍历必须严格前序——walk 的实现即前序。脚注标题（sr-only h2）也吃 slug，
  // 与 GitHub 的 user-content 命名空间互不碰撞（文档标题 id 不带前缀）。
  const slugger = new GithubSlugger()

  const walk = (children: ElementContent[], keyPrefix: string): Array<HastDescriptor | string> =>
    children.map((child, index): HastDescriptor | string => {
      const key = `${keyPrefix}/${index}`
      if (child.type === 'text') return child.value
      if (child.type !== 'element') return ''
      const node = child
      if (node.tagName === 'img') return imageOf(node, key, context)
      if (node.tagName === 'a') return anchorOf(node, key, context, walk)
      if (node.tagName === 'pre') {
        const block = codeBlockOf(node, key)
        if (block !== null) return block
      }
      if (node.tagName === 'input') {
        // 任务清单：消毒已把 type 钉死为 checkbox、disabled 由 to-hast 注入；
        // readOnly 让 React 接受 checked 而不要求 onChange。
        return { key, tag: 'input', props: { type: 'checkbox', checked: node.properties.checked === true, disabled: true, readOnly: true }, children: [] }
      }
      const props = propsOf(node.properties)
      if (/^h[1-6]$/u.test(node.tagName)) {
        props.id = slugger.slug(textOf(node))
      }
      const descriptor: HastDescriptor = {
        key,
        tag: node.tagName,
        props,
        children: VOID_TAGS.has(node.tagName) ? [] : walk(node.children as ElementContent[], key),
      }
      // 宽表格横向滚动：包一层全局类名的容器（CSS 以 :global 承接），避免
      // 整篇文档出现横向滚动条。
      if (node.tagName === 'table') {
        return { key: `${key}/tw`, tag: 'div', props: { className: 'fb-table-scroll' }, children: [descriptor] }
      }
      return descriptor
    })

  return walk(root.children as ElementContent[], 'd')
}
