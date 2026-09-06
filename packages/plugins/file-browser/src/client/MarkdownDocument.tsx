/**
 * 文档预览的 React 渲染层：描述符树 → 元素树。
 *
 * 本组件**不做解析、不做消毒、不做 URL 判定**——那些都在纯函数层
 * （markdown-pipeline.ts / markdown-document.ts）完成并有独立单测。这里只：
 * 1. `createElement(tag, props, ...children)` 展开描述符；
 * 2. 锚点滚动在容器内部消化（querySelector + scrollIntoView，目标 id 由
 *    slugger 保证文档内唯一）；仓内链接外抛给页面层走 tab 打开；
 * 3. 把 `codeblock` 伪标签映射到 ui-primitives 的 CodeBlock。
 *
 * 元素全部来自消毒后的 hast 白名单标签，props 只有查表得到的安全子集，
 * 不存在 `dangerouslySetInnerHTML` 通路。
 */
import { createElement, memo, useCallback, useMemo, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownToSafeHast } from './markdown-pipeline.ts'
import { hastToDescriptors } from './markdown-document.ts'
import type { DocumentRenderContext, HastAction, HastDescriptor } from './markdown-document.ts'
import type { Translate } from './types.ts'
import css from './DocumentPreview.module.css'

/** 组件 props。 */
export interface MarkdownDocumentProps {
  /** Markdown 源文本。 */
  text: string
  /** 纯函数层的上下文（文件位置 + 图片 URL 构造器）。 */
  context: DocumentRenderContext
  /** 页面层注入的翻译座位（脚注标题等本地化 chrome）。 */
  t: Translate
  /** 仓内链接点击（已解析为 tab key 域内的路径）；跨文档片段暂不跟进。 */
  onOpen: (relKey: string) => void
}

/** 锚点滚动：容器内按 id 查找（CSS.escape 兜特殊字符），平滑滚到目标。 */
function scrollWithin(container: HTMLElement | null, target: string): void {
  if (container === null) return
  const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(target)
    : target.replace(/["\\]/gu, '\\$&')
  const element = container.querySelector<HTMLElement>(`[id="${escape}"]`)
  element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 渲染一棵描述符子树（递归；key 已由纯函数层生成）。 */
function renderNodes(
  nodes: Array<HastDescriptor | string>,
  actions: { scroll: (target: string) => void; open: (relKey: string) => void },
): ReactNode[] {
  return nodes.map(node => typeof node === 'string' ? node : renderNode(node, actions))
}

function renderNode(
  node: HastDescriptor,
  actions: { scroll: (target: string) => void; open: (relKey: string) => void },
): ReactNode {
  if (node.tag === 'codeblock') {
    const { code, lang } = node.props as { code: string; lang?: string }
    return createElement(CodeBlock, { key: node.key, code, lang, className: css.codeBlock })
  }
  const props: Record<string, unknown> = { ...node.props, key: node.key }
  const action: HastAction | undefined = node.action
  if (action !== undefined) {
    // 闭包直绑：交互载荷留在描述符里，不经过 dataset 字符串往返。
    props.onClick = (event: ReactMouseEvent): void => {
      event.preventDefault()
      if (action.kind === 'scroll') actions.scroll(action.target)
      else actions.open(action.relKey)
    }
  }
  const children = node.children.length === 0 ? undefined : renderNodes(node.children, actions)
  return createElement(node.tag, props, ...(children ?? []))
}

/**
 * 渲染工作区 Markdown 文档（README 语义：HTML 消毒渲染 + 相对图片 + 锚点）。
 * @param props - 见 {@link MarkdownDocumentProps}。
 */
export const MarkdownDocument = memo(function MarkdownDocument({ text, context, t, onOpen }: MarkdownDocumentProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 解析+消毒是同步纯函数；text 或 context（文件位置）变化才重算。脚注段
  // 标题经 toHast 的 footnoteLabel 本地化，故 t 变化也重算。
  const descriptors = useMemo(() => {
    try {
      return hastToDescriptors(markdownToSafeHast(text, t('preview.footnotes')), context)
    } catch {
      // 解析失败（畸形输入）不崩预览：null 走降级分支。
      return null
    }
  }, [text, context, t])

  const scroll = useCallback((target: string): void => {
    scrollWithin(containerRef.current, target)
  }, [])
  const actions = useMemo(() => ({ scroll, open: onOpen }), [scroll, onOpen])

  if (descriptors === null) {
    return <div className={css.document}><p className={css.fallback}>{t('status.renderFailed')}</p></div>
  }
  return <div ref={containerRef} className={css.document}>{renderNodes(descriptors, actions)}</div>
})
