/**
 * 文档渲染管线单测（纯函数层）：markdownToSafeHast 的消毒语义 +
 * hastToDescriptors 的文档增值（标题锚点 id、图片改写、链接分类、fenced
 * code → codeblock、任务清单、HTML 块渲染）。断言停在描述符结构，
 * 不依赖 jsdom/React。
 */
import { describe, expect, it } from 'vitest'
import { markdownToSafeHast } from '../src/client/markdown-pipeline.ts'
import { hastToDescriptors } from '../src/client/markdown-document.ts'
import type { DocumentRenderContext, HastDescriptor } from '../src/client/markdown-document.ts'

const context: DocumentRenderContext = {
  baseDir: 'docs',
  kind: 'workspace',
  imageSrcFor: (src, via) => `raw://${via}/${src}`,
}

/** 渲染并取描述符树。 */
function render(markdown: string): Array<HastDescriptor | string> {
  return hastToDescriptors(markdownToSafeHast(markdown, 'Footnotes'), context)
}

/** 深度优先找第一个匹配标签的节点。 */
function find(nodes: Array<HastDescriptor | string>, tag: string): HastDescriptor | undefined {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    if (node.tag === tag) return node
    const hit = find(node.children, tag)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 收集全部文本（含字符串子节点）。 */
function text(nodes: Array<HastDescriptor | string>): string {
  return nodes.map(node => typeof node === 'string' ? node : text(node.children)).join('')
}

describe('markdownToSafeHast + hastToDescriptors', () => {
  it('原始 HTML 块渲染为真实元素（聊天侧字面化的核心差异）', () => {
    const nodes = render('<div align="center"><img width="96" src="icon.png" alt="i"></div>')
    const div = find(nodes, 'div')
    expect(div).toBeDefined()
    expect(div?.props.align).toBe('center')
    const img = find(nodes, 'img')
    expect(img?.props.width).toBe(96)
    expect(img?.props.src).toBe('raw://workspace/docs/icon.png')
  })

  it('script/style/事件属性/javascript: 一律被消毒剥除', () => {
    const nodes = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1))\n')
    expect(find(nodes, 'script')).toBeUndefined()
    expect(find(nodes, 'style')).toBeUndefined()
    expect(text(nodes)).not.toContain('alert')
    // onerror 不在属性白名单：img 存活但无事件属性。
    const img = find(nodes, 'img')
    expect(img).toBeDefined()
    expect(img?.props.onerror).toBeUndefined()
    // javascript: 链接降级为惰性 span（无 action、无 href）。
    const jsLink = find(nodes, 'a')
    expect(jsLink).toBeUndefined()
  })

  it('标题按文档序生成 GitHub slug（中文、重复、标点）', () => {
    const nodes = render('# 快速开始\n\n## Hello World\n\n## Hello World\n\n## `code` x\n')
    const ids: unknown[] = []
    const walk = (list: Array<HastDescriptor | string>): void => {
      for (const node of list) {
        if (typeof node === 'string') continue
        if (/^h[1-6]$/u.test(node.tag)) ids.push(node.props.id)
        walk(node.children)
      }
    }
    walk(nodes)
    expect(ids).toEqual(['快速开始', 'hello-world', 'hello-world-1', 'code-x'])
  })

  it('锚点/仓内/外链三类 a 的 action 与 href', () => {
    const nodes = render('[go](#快速开始) [doc](sub/x.md) [ext](https://a.b/c)\n')
    const links: HastDescriptor[] = []
    const walk = (list: Array<HastDescriptor | string>): void => {
      for (const node of list) {
        if (typeof node === 'string') continue
        if (node.tag === 'a') links.push(node)
        walk(node.children)
      }
    }
    walk(nodes)
    expect(links).toHaveLength(3)
    expect(links[0]?.action).toEqual({ kind: 'scroll', target: '快速开始' })
    expect(links[1]?.action).toEqual({ kind: 'open', relKey: 'docs/sub/x.md', fragment: undefined })
    expect(links[2]?.action).toBeUndefined()
    expect(links[2]?.props.href).toBe('https://a.b/c')
    expect(links[2]?.props.target).toBe('_blank')
    expect(links[2]?.props.rel).toBe('noopener noreferrer')
  })

  it('markdown 图片语法与相对路径解析到当前目录', () => {
    const nodes = render('![screenshot](assets/shot.png)\n')
    const img = find(nodes, 'img')
    expect(img?.props.src).toBe('raw://workspace/docs/assets/shot.png')
    expect(img?.props.alt).toBe('screenshot')
    expect(img?.props.loading).toBe('lazy')
  })

  it('越界图片降级为 alt 文本 span', () => {
    const nodes = render('![gone](../../outside.png)\n')
    expect(find(nodes, 'img')).toBeUndefined()
    const alt = find(nodes, 'span')
    expect(alt?.children).toEqual(['gone'])
  })

  it('fenced code → codeblock 伪节点（lang 从 language-* 提取）', () => {
    const nodes = render('```ts\nconst x = 1\n```\n')
    const block = find(nodes, 'codeblock')
    expect(block?.props).toEqual({ code: 'const x = 1\n', lang: 'ts' })
    // 无语言围栏：lang undefined。
    const plain = find(render('```\nhello\n```\n'), 'codeblock')
    expect(plain?.props.lang).toBeUndefined()
  })

  it('GFM 表格/删除线/任务清单渲染', () => {
    const nodes = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ keep\n\n- [x] done\n')
    const table = find(nodes, 'table')
    expect(table).toBeDefined()
    // 表格包在横向滚动容器里（全局类名 div）。
    expect(find(nodes, 'div')?.props.className).toBe('fb-table-scroll')
    expect(text(nodes)).toContain('gone')
    const checkbox = find(nodes, 'input')
    expect(checkbox?.props).toMatchObject({ type: 'checkbox', checked: true, disabled: true })
  })

  it('details/summary 折叠段渲染（README 常用）', () => {
    const nodes = render('<details><summary>more</summary>\n\nhidden body\n\n</details>\n')
    expect(find(nodes, 'details')).toBeDefined()
    expect(find(nodes, 'summary')).toBeDefined()
    expect(text(nodes)).toContain('hidden body')
  })

  it('脚注：引用上标 + 尾部 section，本地化标题透传', () => {
    const nodes = render('ref[^a]\n\n[^a]: note body\n')
    const sup = find(nodes, 'sup')
    expect(sup).toBeDefined()
    const section = find(nodes, 'section')
    expect(section?.props.className).toContain('footnotes')
    // 本地化 footnoteLabel 进入 section 的 h2。
    expect(text([section ?? { key: '', tag: '', props: {}, children: [] }])).toContain('Footnotes')
    // 引用与目标 id 对齐（clobber 关闭后不再有双前缀错位）。
    const refLink = find(nodes, 'a')
    expect(refLink?.props.href).toBe('#user-content-fn-a')
    expect(section && find(section.children, 'li')?.props.id).toBe('user-content-fn-a')
  })

  it('徽章行（链接包 HTML img）保留可点击外链 + 可加载图片', () => {
    const nodes = render('[![ci](https://img.shields.io/x.svg?style=flat)](https://x.com/actions)\n')
    const link = find(nodes, 'a')
    expect(link?.props.href).toBe('https://x.com/actions')
    expect(link?.action).toBeUndefined()
    const img = find(nodes, 'img')
    expect(img?.props.src).toBe('https://img.shields.io/x.svg?style=flat')
  })

  it('空输入与纯空白不抛错', () => {
    expect(render('')).toEqual([])
    expect(render('\n\n')).toEqual([])
  })
})
