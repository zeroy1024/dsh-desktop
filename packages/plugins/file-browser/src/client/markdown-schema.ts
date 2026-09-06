/**
 * 文档预览的 hast 消毒 schema（GitHub 兼容）。
 *
 * 威胁模型与聊天侧的 `MarkdownText` 不同：那里的输入是**不可信的 assistant
 * 输出**，故上游一律把原始 HTML、相对链接与不安全协议按字面文本处理；这里
 * 的输入是**用户工作区里的 Markdown 文件**（可能来自克隆的仓库，仍不可全信，
 * 但语义是"仓库 README"）。GitHub 对 repo README 的策略是「渲染但消毒」，
 * 本 schema 就是该策略的数据驱动表达：
 *
 * - 放行 GitHub  flavored 的展示性标签（`div align`、`details/summary`、
 *   `kbd/sub/sup/ins/section`、`figure` 等），使 README 的门面层不被字面化；
 * - `script/iframe/style/object/embed/link/meta/base/form` 等可执行或可外联
 *   标签一律不在白名单内 → `hast-util-sanitize` 连其子树一起丢弃；
 * - 事件处理器属性（`onerror` 等）与 `javascript:` 协议由默认 schema 剥离；
 * - `src` 协议白名单额外放行 `data:`（内联图片是 README 的常见构造），
 *   `href` 保留默认的 http/https/mailto/xmpp/irc 集，锚点的 `#` 形态在
 *   `protocols` 判定之外（无协议），由 `document-links.ts` 分类处理。
 *
 * 不引入自研 sanitizer：全部规则是本包唯一事实来源的数据表。
 */
import { defaultSchema } from 'hast-util-sanitize'
import type { Schema } from 'hast-util-sanitize'

/** 展示性标签增量：GitHub README 常用、无脚本语义。 */
const DISPLAY_TAGS = [
  'details', 'summary', 'figure', 'figcaption', 'picture', 'source',
  'mark', 'abbr', 'cite', 'dfn', 'time', 'var', 'samp', 'kbd',
  'section', 'article', 'header', 'footer', 'nav', 'aside',
  'colgroup', 'col', 'caption',
] as const

/**
 * 展示性属性增量。**按键合并**到默认表之上（默认 `img` 已含 `src/alt`，
 * 直接展开覆盖会连带删掉 `src` → 图片被消毒剥空）。
 */
const DISPLAY_ATTRIBUTES: Record<string, Array<string | [string, ...unknown[]]>> = {
  // img 的 align 是 README 徽章行的常见遗留写法；loading/decoding 由渲染层
  // 注入但登记进白名单，防未来把 img 交回 sanitize 往返时被剥。
  img: ['align', 'loading', 'decoding'],
  source: ['srcset', 'media', 'type'],
  details: ['open'],
}

/** 合并两个属性表：同名键的白名单取并集（保序去重）。 */
function mergeAttributes(
  base: Schema['attributes'],
  extra: Record<string, Array<string | [string, ...unknown[]]>>,
): Schema['attributes'] {
  const out: Record<string, Array<string | [string, ...unknown[]]>> = { ...base }
  for (const [tag, names] of Object.entries(extra)) {
    const existing = out[tag] ?? []
    out[tag] = [...existing, ...names.filter(name => !existing.includes(name))]
  }
  return out as Schema['attributes']
}

/**
 * 构造文档预览 schema。导出函数而非常量：调用方（MarkdownDocument）在模块
 * 装载时构造一次并复用，`sanitize` 不修改入参 schema。
 * @returns 可直接交给 `hast-util-sanitize` 的 schema。
 */
export function documentSchema(): Schema {
  return {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), ...DISPLAY_TAGS],
    attributes: mergeAttributes(defaultSchema.attributes, DISPLAY_ATTRIBUTES),
    protocols: {
      ...defaultSchema.protocols,
      // 内联 data URI 图片（README 里的 base64 徽标）；svg 的 data URI 在
      // <img> 上下文不执行脚本，与 raw 路由的 svg 同策。
      src: [...(defaultSchema.protocols?.src ?? []), 'data'],
    },
  }
}
