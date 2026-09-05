/** vitest 里顶替平台模块表的 primitives stub（正式运行时由 web 壳提供）。 */
import type { ReactElement, ReactNode } from 'react'

export interface IconProps {
  size?: number
  className?: string
}

export const IconCheckOutline14 = (_props: IconProps): ReactElement => <span data-icon="check" />
export const IconChecklistOutline14 = (_props: IconProps): ReactElement => <span data-icon="checklist" />
export const writeClipboard = async (_text: string): Promise<boolean> => true
export const IconChevronDownOutline14 = (_props: IconProps): ReactElement => <span data-icon="chevron-down" />
export const IconChevronRightOutline14 = (_props: IconProps): ReactElement => <span data-icon="chevron-right" />
export const IconCloseFill14 = (_props: IconProps): ReactElement => <span data-icon="close" />
export const IconCopyOutline16 = (_props: IconProps): ReactElement => <span data-icon="copy" />

export const IconRefreshOutline14 = (_props: IconProps): ReactElement => <span data-icon="refresh" />
export function Menu({ open, anchor, items, onSelect }: {
  open: boolean; anchor: ReactNode; items: readonly { id: string; label: string }[]; onSelect: (id: string) => void
}): ReactElement {
  return <>{anchor}{open && <div role="menu">{items.map(item => <button role="menuitem" key={item.id} onClick={() => { onSelect(item.id) }}>{item.label}</button>)}</div>}</>
}
