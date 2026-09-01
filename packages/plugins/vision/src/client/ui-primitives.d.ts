/** Runtime UI primitive supplied by dsh's web platform module table. */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  export interface IconProps {
    size?: number
    className?: string
  }

  export const IconChevronDownOutline14: (props: IconProps) => ReactElement
}
