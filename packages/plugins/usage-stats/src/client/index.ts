/**
 * usage-stats 的浏览器客户端插件：注册官方词典，并在 settings.section
 * 声明存在时挂「用量统计」页。数据读走 node 半挂在 webServer 上的同源
 * summary 路由；图标走 settings.section.icon 缝（patch 0014，缺省有齿轮兜底）。
 */
import { UsageSectionIcon } from './UsageSectionIcon.tsx'
import { UsageStatsSection } from './UsageStatsSection.tsx'
import { en, NS, zh } from './locales.ts'
import type { ClientContext } from './types.ts'

/** locale 与 slots 是本插件装配时的根依赖。 */
export const inject = ['locale', 'slots']

/** 注册本插件词典，并把设置页挂进 settings.section 列表槽。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-stats: dictionaries')

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage',
    order: 40,
    label: () => t('nav'),
    locale: NS,
  }, UsageStatsSection))
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon', key: 'usage',
  }, UsageSectionIcon))
}
