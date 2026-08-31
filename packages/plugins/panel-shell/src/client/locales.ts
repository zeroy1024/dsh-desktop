/**
 * `panel-shell` 命名空间词典（开关、tab 条、空态、引导）。键集即契约：
 * 两份词典必须同键齐备。上游同款词典还经 LocaleNamespaceMap 声明做类型
 * 收口，但那需要真实的 ui-slots 类型包（vendor gitignore），故此处仅以
 * PanelShellKey 联合类型承担同一职责。
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'panel-shell'

/** The panel-shell dictionary key set (the source of truth for both locales). */
export type PanelShellKey =
  | 'toggle.aria'
  | 'expand.aria'
  | 'collapseExpanded.aria'
  | 'tabs.aria'
  | 'tab.close'
  | 'menu.open'
  | 'menu.label'
  | 'empty.title'
  | 'empty.guide'
  | 'empty.none'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<PanelShellKey, string> = {
  'toggle.aria': '侧边面板',
  'expand.aria': '全屏显示面板',
  'collapseExpanded.aria': '还原面板',
  'tabs.aria': '面板页标签',
  'tab.close': '关闭页面',
  'menu.open': '添加面板页',
  'menu.label': '添加页面',
  'empty.title': '没有打开的页面',
  'empty.guide': '选择一个页面开始在侧边面板中工作',
  'empty.none': '尚无可用页面——安装面板页插件后会出现在这里',
}

/** English dictionary. */
export const en: Record<PanelShellKey, string> = {
  'toggle.aria': 'Side panel',
  'expand.aria': 'Expand panel',
  'collapseExpanded.aria': 'Restore panel',
  'tabs.aria': 'Panel page tabs',
  'tab.close': 'Close page',
  'menu.open': 'Add a panel page',
  'menu.label': 'Add a page',
  'empty.title': 'No open pages',
  'empty.guide': 'Pick a page to start working in the side panel',
  'empty.none': 'No pages available — panel page plugins will appear here once installed',
}
