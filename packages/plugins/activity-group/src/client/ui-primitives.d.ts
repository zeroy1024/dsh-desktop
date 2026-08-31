/**
 * 运行时外部模块声明：这些值由浏览器端的加载器模块表提供（plugin-kit
 * PLATFORM_MODULES 平台基线），bundle 时是 external，运行时解析到宿主的
 * ui-primitives 实例——与上游同类插件的 import 面一致，这里只为让 tsc 可查。
 * 上游权威定义：upstream/packages/client/ui-primitives/src/DisclosureRow.tsx
 * 与 src/icons/。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  // import 必须留在 declare module 体内：文件顶层 import 会把本文件变成
  // ES 模块，ambient 声明就退化成对不存在模块的 module augmentation。
  import type { ReactElement, ReactNode } from 'react'

  /** 24px 折叠行共用外壳：头部 + 受控展开内容。 */
  export interface DisclosureRowProps {
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    /** 整个标题行成为折叠目标。 */
    expandOnRowClick?: boolean | undefined
    /** 悬停时把收起的图标替换为 chevron。 */
    previewChevron?: boolean | undefined
    /** 展开时保持 collapsedContent 内联。 */
    keepContentWhenOpen?: boolean | undefined
    collapsedContent?: ReactNode
    children?: ReactNode
    className?: string | undefined
    rowClassName?: string | undefined
    leadingClassName?: string | undefined
    chevronClassName?: string | undefined
    titleClassName?: string | undefined
  }

  export function DisclosureRow(props: DisclosureRowProps): ReactElement | null

  export interface IconProps {
    size?: number
    className?: string
  }

  export const IconApiOutline14: (props: IconProps) => ReactElement
  export const IconChecklistOutline14: (props: IconProps) => ReactElement
  export const IconThinkOutline14: (props: IconProps) => ReactElement
}
