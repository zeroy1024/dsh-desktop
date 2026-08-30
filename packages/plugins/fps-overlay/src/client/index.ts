import type { ClientContext } from './types.ts'
import { FpsBadge } from './FpsBadge.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  if (window.dshDesktop?.dev !== true) return
  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'fps-overlay', order: 50 }, FpsBadge),
    )
  }, 'fps-overlay: hud')
}
