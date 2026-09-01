/**
 * file-browser 用到的 ui-primitives 增量导出（panel-shell 的
 * ui-primitives.d.ts 已声明 Menu/IconCloseFill14/IconPlusOutline16 等，
 * ambient declare module 跨文件合并，这里只补缺口、绝不重复声明）。
 * bundle 时整个模块是 external，浏览器里由加载器模块表解析到宿主实例。
 * 上游权威定义：upstream/packages/client/ui-primitives/src/。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { InputHTMLAttributes, MouseEvent, ReactElement, ReactNode } from 'react'

  export const Button: (props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
    type?: 'button' | 'submit'
    disabled?: boolean
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void
    'aria-label'?: string
    title?: string
  }) => ReactElement

  export const Input: (props: { icon?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) => ReactElement

  export const Tooltip: (props: {
    label: string | (() => string)
    side?: 'top' | 'right' | 'bottom' | 'left'
    children: ReactElement
  }) => ReactElement

  export const CodeBlock: (props: {
    code: string
    lang?: string
    className?: string
    copyLabel?: string
    copiedLabel?: string
  }) => ReactElement

  export const MarkdownText: (props: { text: string }) => ReactElement

  export function writeClipboard(text: string): Promise<boolean>

  export const IconChevronLeftOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconChevronRightOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconCopyOutline16: (props: { size?: number; className?: string }) => ReactElement
  export const IconFolderOpen16: (props: { size?: number; className?: string }) => ReactElement
  export const IconFolderClose16: (props: { size?: number; className?: string }) => ReactElement
  export const IconRefreshOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconSearchOutline16: (props: { size?: number; className?: string }) => ReactElement
  export const IconBrowseOutline16: (props: { size?: number; className?: string }) => ReactElement
}
