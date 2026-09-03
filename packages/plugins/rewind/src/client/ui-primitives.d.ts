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

  export const IconCheckOutline16: (props: IconProps) => ReactElement
  export const IconCopyOutline16: (props: IconProps) => ReactElement

  export function Tooltip(props: {
    label: string
    side?: 'top' | 'bottom' | 'left' | 'right'
    delayMs?: number
    disabled?: boolean
    children: ReactElement
  }): ReactElement

  export function MessageText(props: { text: string }): ReactElement

  export function JsonBlock(props: {
    label: string
    payload: unknown
    defaultOpen?: boolean
    truncatedLabel?: ((total: number) => string) | undefined
  }): ReactElement

  export function writeClipboard(text: string): Promise<boolean>
}
