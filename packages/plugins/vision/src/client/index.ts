/** Browser half of dsh-vision: one keyed card in the shared plugin settings tab. */

import { VisionCard } from './VisionCard.tsx'
import { VisionCardController, VISION_NS } from './vision-card-controller.ts'
import type { ClientContext } from './types.ts'
import { credentialAdapter } from './credentials.ts'
import { en, NS, zh } from './locales.ts'

export { VisionCardController, VISION_NS } from './vision-card-controller.ts'
export type { VisionCardState, VisionCardFace, VisionSettings } from './vision-card-controller.ts'
export type { ClientContext, VisionCardProps } from './types.ts'

export { inject } from './dependencies.ts'

export function apply(ctx: ClientContext): void {
  const controller = new VisionCardController(
    ctx.settingsScope.bind({ namespace: VISION_NS }),
    { api: { credentials: credentialAdapter(ctx.remote!) } },
  )

  ctx.effect(() => {
    const dispose = ctx.locale.register(NS, { zh, en })
    return typeof dispose === 'function' ? () => { dispose() } : undefined
  }, 'dsh-vision: dictionaries')
  ctx.effect(() => {
    const off = ctx.remote?.$on?.('credentials/reference-updated', ref => {
      controller.refreshCredential(ref)
    })
    return () => { off?.() }
  }, 'dsh-vision: credential invalidations')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: VISION_NS,
    locale: NS,
    inject: () => controller.inject(),
  }, VisionCard))
}
