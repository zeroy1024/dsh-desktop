import type { ClientContext } from './types.ts'
import { HelloBadge } from './HelloBadge.tsx'

/** cordis fiber 依赖：slots 由 runtime 提供。 */
export const inject = ['slots']

/**
 * 挂到 AppFrame 的 shell.overlay（加性 list 槽，不替换官方布局）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'hello-panel', order: 100 }, HelloBadge),
    )
  }, 'hello-panel: overlay')
}
