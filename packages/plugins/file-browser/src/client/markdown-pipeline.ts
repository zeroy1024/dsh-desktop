/**
 * 文档预览的 Markdown → hast 管线（纯函数，无 React/DOM 依赖）。
 *
 * 链路：`mdast-util-from-markdown`（+GFM）→ `mdast-util-to-hast`
 * （allowDangerousHtml，保留 raw 节点）→ `hast-util-raw`（把 raw 解析成
 * 真实元素，这是"渲染 README 里的 HTML"的实现点）→ `hast-util-sanitize`
 * （GitHub 兼容 schema，见 markdown-schema.ts）。
 *
 * 与上游 `MarkdownText` 的关系：**并行实现，不共享代码**。上游管线的
 * "HTML 一律字面化 + 拒绝相对/锚点 URL" 是为不可信聊天输出设定的成文契约
 * （其 JSDoc 明示），文档预览的威胁模型（工作区文件）需要相反的取值；
 * 强行给共享组件开 trusted 后门会同时污染两个场景。语法层（GFM 扩展、
 * 版本）与上游对齐，保证同一份 Markdown 在两侧块结构一致。
 *
 * 数学（TeX）与 KaTeX 不在本管线内：那是聊天侧的增值件，README 场景的
 * 数学块以源码文本呈现（`math` 节点在 to-hast 后无映射 → 渲染为原文），
 * 不为此引入 katex 依赖与 CSS 注入面。
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { toHast } from 'mdast-util-to-hast'
import { raw } from 'hast-util-raw'
import { sanitize } from 'hast-util-sanitize'
import type { Root as HastRoot } from 'hast'
import { documentSchema } from './markdown-schema.ts'

/**
 * 消毒 schema 构造一次并复用。`clobberPrefix` 置空是脚注互链正确性的
 * 必需：`toHast` 已给脚注 id 冠上自己的 `user-content-` 前缀，sanitize 若
 * 再按默认前缀二次冠名，引用侧 href 与目标侧 id 就会错位（实测
 * `#user-content-fn-a` 指向 `user-content-user-content-fn-a`）。`user-content-`
 * 前缀本身已是命名空间，clobber 保护在此冗余。
 */
const SCHEMA = { ...documentSchema(), clobberPrefix: '' }

/**
 * 把 Markdown 源解析并消毒成可安全渲染的 hast 树。
 * @param text - Markdown 源文本。
 * @param footnoteLabel - 脚注段标题的本地化文案（toHast 默认硬编码英文）。
 * @returns 消毒后的 hast root（raw 节点已被解析为真实元素）。
 */
export function markdownToSafeHast(text: string, footnoteLabel: string): HastRoot {
  const mdast = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  const hast = toHast(mdast, { allowDangerousHtml: true, footnoteLabel })
  // raw()/sanitize() 的类型面是泛化的 Nodes→Nodes：输入 Root 时产物必为 Root
  // （两者都只展开/过滤子节点，不改容器类型），断言收敛在这里一次完成。
  return sanitize(raw(hast) as HastRoot, SCHEMA) as HastRoot
}
