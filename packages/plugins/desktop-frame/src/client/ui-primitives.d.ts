/**
 * 运行时由 web platform 的模块表提供的 primitives 类型面。
 * 这里只声明本插件实际消费的值；不把上游 src 引入我们的 workspace。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  /** 悬浮/聚焦提示气泡：cloneElement 包住锚点（不产生包装 DOM 节点）；可见时 Fragment 多一个 position:fixed 的气泡兄弟。 */
  export function Tooltip(props: {
    label: string | (() => string)
    side?: 'top' | 'bottom' | 'right'
    delayMs?: number
    disabled?: boolean
    maxWidth?: number
    children: ReactElement
  }): ReactElement
}
