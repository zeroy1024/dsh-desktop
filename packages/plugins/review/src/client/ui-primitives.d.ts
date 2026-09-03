/**
 * 运行时外部模块声明（panel-shell 的 ui-primitives.d.ts 已声明 Menu 与四个
 * 图标，ambient declare module 跨文件合并，这里只补本插件用到的导出，绝不
 * 重复声明）。bundle 时整个模块是 external，浏览器里由加载器模块表解析到
 * 宿主实例。上游权威定义：upstream/packages/client/ui-primitives/src/。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  /** 上游 DiffBlock 的行折叠默认值（头尾各半折叠中段）。 */
  export const DEFAULT_DIFF_MAX_LINES: number

  /** 一次文件变更的 hunk 数据（与 tool-fs 的 FileDiff 结构同构）。 */
  export interface DiffHunk {
    path: string
    oldText: string | null
    newText: string
  }

  export const IconChecklistOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconChevronRightOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconChevronDownOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconCheckOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconRefreshOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconCopyOutline16: (props: { size?: number; className?: string }) => ReactElement
  export const IconTrashOutline16: (props: { size?: number; className?: string }) => ReactElement
  export const IconSendOutline14: (props: { size?: number; className?: string }) => ReactElement
  export const IconCloseFill14: (props: { size?: number; className?: string }) => ReactElement

  export function writeClipboard(text: string): Promise<boolean>
}
