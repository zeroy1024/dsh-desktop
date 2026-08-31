/**
 * 运行时外部模块声明：这些值由浏览器端的加载器模块表提供（plugin-kit
 * PLATFORM_MODULES 平台基线），bundle 时是 external，运行时解析到宿主的
 * ui-primitives 实例——与上游同类插件的 import 面一致，这里只为让 tsc 可查。
 * 上游权威定义：upstream/packages/client/ui-primitives/src/。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  // import 必须留在 declare module 体内：文件顶层 import 会把本文件变成
  // ES 模块，ambient 声明就退化成对不存在模块的 module augmentation。
  import type { ReactElement, ReactNode } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  export const IconCloseFill14: (props: IconProps) => ReactElement
  export const IconPlusOutline16: (props: IconProps) => ReactElement

  /** 浮层菜单（portal 渲染）：anchor 为触发元素，items 选中即回调。 */
  export interface MenuItem {
    id: string
    label: string
    icon?: ReactNode
  }

  export interface MenuProps {
    open: boolean
    align?: 'start' | 'end'
    anchor: ReactNode
    items: readonly MenuItem[]
    onSelect: (id: string) => void
    onClose: () => void
    portal?: boolean
  }

  export function Menu(props: MenuProps): ReactElement | null
}
