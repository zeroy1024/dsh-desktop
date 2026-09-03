/**
 * review 的 browser 半：把「审查」页注册进 panel-shell（两半注册一个
 * effect 的事务纪律，panel-page-stub 范本）。sessionMode:'required'——无
 * 当前会话时整个 tab 不可见（改动源锚定会话事件流）。order:30 排在轨迹页
 * （10）与文件页（20）之后。
 */
import { createElement } from 'react'
import { IconChecklistOutline14, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from './types.ts'
import { setHostWriteClipboard } from './copy.ts'
import { ReviewPage } from './ReviewPage.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services（loader 把本模块全部导出当对象插件交给 cordis fiber）。 */
export const inject = ['slots', 'locale', 'panelShell', 'connection']

/**
 * 插件体：一个 apply，两半注册。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  // 剪贴板兜底链的宿主实例（与上游复制控件同一 writeClipboard）。
  ctx.effect(() => {
    setHostWriteClipboard((text) => writeClipboard(text))
  }, 'review: host clipboard')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'review: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('panel-shell.page', () => {
    const disposeMeta = ctx.panelShell.registerPage({
      id: 'review',
      title: () => t('page.title'),
      icon: createElement(IconChecklistOutline14, { size: 14 }),
      order: 30,
      sessionMode: 'required',
    })
    const disposeSlot = ctx.slots.register({
      name: 'panel-shell.page',
      id: 'review',
      locale: NS,
      inject: () => ({ envelopeSource: ctx.connection.api }),
    }, ReviewPage)
    return () => {
      disposeSlot()
      disposeMeta()
    }
  })
}
