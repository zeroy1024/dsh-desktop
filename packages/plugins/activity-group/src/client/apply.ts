/** Register the chat flow grouping service and the group summary row. */
import type { ClientContext } from './types.ts'
import { ActivityGroupRow } from './ActivityGroupRow.tsx'
import { foldNodes } from './flow-group.ts'
import { en, NS, zh } from './locales.ts'

/** Required service: the slot registry. */
export const inject = ['slots', 'locale']

/**
 * Mount the activity grouping: the flow assembly service (pure folding) plus
 * the `conversation.chat.group` summary-row occupant. Composing this plugin
 * out of the roster turns both off together — the chat view falls back to the
 * flattened transcript. This plugin owns the summary row's dictionaries.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'activity-group: dictionaries')
  ctx.provide('chatFlowGrouping', { group: foldNodes })
  ctx.slots.inject('conversation.chat.group', () => ctx.slots.register({
    name: 'conversation.chat.group',
    locale: NS,
  }, ActivityGroupRow))
}
