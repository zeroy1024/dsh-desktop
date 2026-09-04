/**
 * locales.ts — 窗框自绘文案（顶级菜单标签 + titleband 按钮）的 zh/en 字典，
 * 以及给组件用的 locale 可观察 store。
 *
 * 字典独立维护（不依赖上游 locale 包的导出面，只经注入的 dsh-client-locale
 * 读当前 active id）；按惯例 zh 之外一律回落 en。注：主进程 native popup
 * 的菜单项是 English roles（Electron 内置标签），顶级标签在页面里本地化，
 * 两者互不影响。
 */

/** 顶级菜单标签（顺序与主进程 application-menu.ts 的模板一一对应）。 */
export interface ApplicationMenuLabelSet {
  file: string
  edit: string
  view: string
  window: string
}

export const MENUBAR_ORDER = ['file', 'edit', 'view', 'window'] as const
export type MenubarMenuId = (typeof MENUBAR_ORDER)[number]

/** IPC/桥面把 menu id 当 string 传来；渲染进程只接受闭合联合。 */
export function isMenubarMenuId(value: unknown): value is MenubarMenuId {
  return typeof value === 'string' && (MENUBAR_ORDER as readonly string[]).includes(value)
}

/** 窗框文案字典（key 与 Titleband/ApplicationMenuBar 的 t() 调用点对应）。 */
export const DICTIONARIES: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    'menubar.file': '文件',
    'menubar.edit': '编辑',
    'menubar.view': '视图',
    'menubar.window': '窗口',
    'menubar.aria': '应用菜单',
    'titleband.sidebar.expand': '展开侧栏',
    'titleband.sidebar.collapse': '收起侧栏',
    'titleband.newSession': '新会话',
    'titleband.panel.expand': '放大面板',
    'titleband.panel.restore': '恢复面板宽度',
    'titleband.panel.open': '打开面板',
    'titleband.panel.close': '关闭面板',
  },
  en: {
    'menubar.file': 'File',
    'menubar.edit': 'Edit',
    'menubar.view': 'View',
    'menubar.window': 'Window',
    'menubar.aria': 'Application menu',
    'titleband.sidebar.expand': 'Open sidebar',
    'titleband.sidebar.collapse': 'Collapse sidebar',
    'titleband.newSession': 'New session',
    'titleband.panel.expand': 'Expand side panel',
    'titleband.panel.restore': 'Restore panel width',
    'titleband.panel.open': 'Open side panel',
    'titleband.panel.close': 'Close side panel',
  },
}

/** 按当前 locale 取词条；未知名回落到 en。 */
export function desktopFrameT(locale: string, key: string): string {
  const dict = locale === 'zh' ? DICTIONARIES.zh : DICTIONARIES.en
  return dict[key] ?? DICTIONARIES.en[key] ?? key
}

const LABELS: Record<'zh' | 'en', ApplicationMenuLabelSet> = Object.freeze({
  zh: Object.freeze({ file: '文件', edit: '编辑', view: '视图', window: '窗口' }),
  en: Object.freeze({ file: 'File', edit: 'Edit', view: 'View', window: 'Window' }),
})

/** 按当前 locale 取顶级菜单标签；未知名回落到 en。每次返回同一冻结对象。 */
export function applicationMenuLabels(locale: string): ApplicationMenuLabelSet {
  return locale === 'zh' ? LABELS.zh : LABELS.en
}

/** locale 快照：单个对象同时携带 locale id 与菜单标签（uSES 稳定引用）。 */
export interface FrameLocaleSnapshot {
  localeId: string
  labels: ApplicationMenuLabelSet
}

/** 组件侧 locale 可观察（apply 闭包创建，注入 ctx.locale.subscribe 驱动）。 */
export interface FrameLocaleStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): FrameLocaleSnapshot
}

/**
 * 创建窗框 locale store。getActiveLocale 是读取上游 locale 快照的 thunk
 * （apply 闭包持有 crx.locale）；setLocale 由 locale 订阅回调调用。
 */
export function createFrameLocaleStore(getActiveLocale: () => string): FrameLocaleStore & {
  setLocale(localeId: string): void
} {
  let active = getActiveLocale()
  let snapshot: FrameLocaleSnapshot = { localeId: active, labels: applicationMenuLabels(active) }
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot() {
      return snapshot
    },
    setLocale(localeId) {
      if (localeId === active) return
      active = localeId
      snapshot = { localeId, labels: applicationMenuLabels(localeId) }
      for (const listener of listeners) listener()
    },
  }
}