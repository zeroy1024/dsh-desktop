/**
 * archive-manager 的浏览器客户端插件：注册官方词典，并在 settings.section
 * 声明存在时挂「归档管理」页。数据读走 slot 渲染器注入的全局座位 hook，
 * 写走 host 半挂在 webServer 上的同源恢复路由。
 */
import { ArchiveManagerSection } from './ArchiveManagerSection.tsx'
import { en, NS, zh } from './locales.ts'
import type { ClientContext } from './types.ts'

/** locale 与 slots 是本插件装配时的根依赖。 */
export const inject = ['locale', 'slots']

/** 注册本插件词典，并把设置页挂进 settings.section 列表槽。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'archive-manager: dictionaries')

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'archive-manager',
    order: 90,
    label: () => t('nav'),
    locale: NS,
  }, ArchiveManagerSection))
}
