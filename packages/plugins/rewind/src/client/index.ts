/**
 * rewind 的浏览器客户端插件：以更低 priority shadow 官方 key='user' 的
 * 消息渲染器（官方为 fallback），hover 提供「撤回编辑」。撤回执行走 host
 * 半挂在 webServer 上的同源路由；墓碑事件不渲染任何标记（单用户场景接缝
 * 自明，未认领的墓碑被上游 fallback 静默忽略），视图收缩由事件回推完成。
 */
import { RewindUserMessage } from './RewindUserMessage.tsx'
import { en, NS, zh } from './locales.ts'
import type { ClientContext } from './types.ts'

/** locale 与 slots 是本插件装配时的根依赖。 */
export const inject = ['locale', 'slots']

/** 注册词典，并 shadow 官方用户消息渲染器。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rewind: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    // 官方 ui-conversation 用默认 priority 0；更低者胜出，官方仍是 fallback。
    priority: -1,
    locale: NS,
  }, RewindUserMessage))
}
