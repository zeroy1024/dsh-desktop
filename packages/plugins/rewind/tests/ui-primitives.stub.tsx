/** vitest 里顶替平台模块表的 primitives stub（正式运行时由 web 壳提供）。 */
import type { ReactElement } from 'react'

export interface IconProps {
  size?: number
  className?: string
}

export const IconCheckOutline16 = (_props: IconProps): ReactElement => <span data-icon="check" />
export const IconCopyOutline16 = (_props: IconProps): ReactElement => <span data-icon="copy" />

export function Tooltip({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <span data-tooltip={label}>
      {children}
    </span>
  )
}

export function MessageText({ text }: { text: string }): ReactElement {
  return <span data-message-text={text.length}>{text}</span>
}

export function JsonBlock({ label }: { label: string; payload?: unknown }): ReactElement {
  return <div data-json-block={label} />
}

export async function writeClipboard(_text: string): Promise<boolean> {
  return true
}
