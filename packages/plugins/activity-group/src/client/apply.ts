/** Register the chat flow grouping service and the group summary row. */
import type { ClientContext } from './types.ts'
import { ActivityGroupRow } from './ActivityGroupRow.tsx'
import { foldNodes } from './flow-group.ts'

/** Required service: the slot registry. */
export const inject = ['slots']

/**
 * Mount the activity grouping: the flow assembly service (pure folding) plus
 * the `conversation.chat.group` summary-row occupant. Composing this plugin
 * out of the roster turns both off together — the chat view falls back to the
 * flattened transcript. Row copy rides the `conversation` locale namespace
 * (`group.*` keys, owned by ui-conversation), so no dictionary registration
 * lives here.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.provide('chatFlowGrouping', { group: foldNodes })
  ctx.slots.inject('conversation.chat.group', () => ctx.slots.register({
    name: 'conversation.chat.group',
    locale: 'conversation',
  }, ActivityGroupRow))
}
