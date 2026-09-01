/**
 * 运行时由 web platform 的模块表提供的 primitives 类型面。
 * 这里只声明本插件实际消费的值；不把上游 src 引入我们的 workspace。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  export const IconCheckOutline16: (props: IconProps) => ReactElement
  export const IconChevronDownOutline14: (props: IconProps) => ReactElement
  export const IconWarningOutline16: (props: IconProps) => ReactElement

  export function Toast(props: {
    text: string
    icon?: ReactNode
    anchor?: HTMLElement | null
    onDone: () => void
  }): ReactElement
}
