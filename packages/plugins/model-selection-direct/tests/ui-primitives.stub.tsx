import type { ReactElement, ReactNode } from 'react'

const Icon = (): ReactElement => <span aria-hidden="true" />

export const IconCheckOutline16 = Icon
export const IconChevronDownOutline14 = Icon
export const IconWarningOutline16 = Icon

/** Deterministic non-portal Toast face for component tests. */
export function Toast({ text }: { text: string; icon?: ReactNode; onDone: () => void }): ReactElement {
  return <div role="alert">{text}</div>
}
