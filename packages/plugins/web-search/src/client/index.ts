/** Browser half: one keyed settings card for the host `web-search` namespace. */

import { WebSearchCard } from './WebSearchCard.tsx'
import { WebSearchCardController, WEB_SEARCH_NS } from './controller.ts'
import type { ClientContext } from './types.ts'
import { credentialAdapter } from './credentials.ts'
import { en, zh } from './locales.ts'

/** Cordis services supplied by the composed web settings surface. */
export { inject } from './dependencies.ts'

/** Client-side locale namespace; the Host namespace remains `web-search`. */
export const CLIENT_LOCALE_NS = 'settings.webSearch'

export { WebSearchCardController, WEB_SEARCH_NS } from './controller.ts'
export type {
  WebSearchCardFace,
  WebSearchCardState,
  WebSearchSettings,
} from './controller.ts'
export type {
  CardActions,
  CardFieldSpec,
  CardFieldState,
  CardShell,
  FieldWrite,
} from './card-form.ts'

export function apply(ctx: ClientContext): void {
  const controller = new WebSearchCardController(
    ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }),
    { credentials: credentialAdapter(ctx.remote) },
  )

  ctx.effect(
    () => ctx.locale.register(CLIENT_LOCALE_NS, { zh, en }),
    'web-search: dictionaries',
  )

  ctx.effect(() => {
    const off = ctx.remote.$on('credentials/reference-updated', ref => {
      controller.refreshCredential(ref)
    })
    return () => { off() }
  }, 'web-search: credential invalidations')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: WEB_SEARCH_NS,
    locale: CLIENT_LOCALE_NS,
    inject: () => controller.inject(),
  }, WebSearchCard))
}
