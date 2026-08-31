/**
 * `panel-stub` 命名空间词典（诊断页自己的字符串）。键集即契约：两份词典
 * 必须同键齐备。上游同款词典还经 LocaleNamespaceMap 声明做类型收口，但那
 * 需要真实的 ui-slots 类型包（vendor gitignore），故此处仅以 PanelStubKey
 * 联合类型承担同一职责。
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'panel-stub'

/** The panel-stub dictionary key set (the source of truth for both locales). */
export type PanelStubKey =
  | 'page.title'
  | 'section.kit'
  | 'section.lifecycle'
  | 'section.badge'
  | 'section.pages'
  | 'kit.sessionId'
  | 'kit.active'
  | 'kit.active.yes'
  | 'kit.active.no'
  | 'lifecycle.empty'
  | 'badge.increase'
  | 'badge.decrease'
  | 'badge.none'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<PanelStubKey, string> = {
  'page.title': '诊断',
  'section.kit': '契约注入',
  'section.lifecycle': '生命周期回调',
  'section.badge': 'Badge 演示',
  'section.pages': '已注册页面',
  'kit.sessionId': 'sessionId',
  'kit.active': 'active',
  'kit.active.yes': '是（当前 tab）',
  'kit.active.no': '否（保持挂载）',
  'lifecycle.empty': '尚无翻转记录——切换 tab 时此处记录 onActivate / onDeactivate',
  'badge.increase': '+1',
  'badge.decrease': '−1',
  'badge.none': '未设置（undefined 不渲染角标）',
}

/** English dictionary. */
export const en: Record<PanelStubKey, string> = {
  'page.title': 'Diagnostics',
  'section.kit': 'Owner contract kit',
  'section.lifecycle': 'Lifecycle callbacks',
  'section.badge': 'Badge demo',
  'section.pages': 'Registered pages',
  'kit.sessionId': 'sessionId',
  'kit.active': 'active',
  'kit.active.yes': 'yes (active tab)',
  'kit.active.no': 'no (kept mounted)',
  'lifecycle.empty': 'No flips yet — switching tabs logs onActivate / onDeactivate here',
  'badge.increase': '+1',
  'badge.decrease': '−1',
  'badge.none': 'unset (undefined renders no badge)',
}
