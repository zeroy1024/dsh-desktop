/**
 * menu-model.ts — 自绘顶级菜单栏的纯模型（键盘/标签面）。
 * DOM 组件只做事件接线；标签字典、mnemonic 归属、循环位移等可测逻辑全部在此。
 */
import {
  MENUBAR_ORDER,
  type ApplicationMenuLabelSet,
  type MenubarMenuId,
} from './locales.ts'

export type { ApplicationMenuLabelSet, MenubarMenuId } from './locales.ts'

/** 顶级菜单固定顺序（与主进程 application-menu.ts 的模板一一对应）。 */
export const APPLICATION_MENU_ORDER: readonly MenubarMenuId[] = MENUBAR_ORDER

/** 循环位移：从当前菜单移到相邻顶级菜单（-1 左 / 1 右）。 */
export function nextMenuId(current: MenubarMenuId, direction: -1 | 1): MenubarMenuId {
  const index = APPLICATION_MENU_ORDER.indexOf(current)
  const next = (index + direction + APPLICATION_MENU_ORDER.length) % APPLICATION_MENU_ORDER.length
  return APPLICATION_MENU_ORDER[next]
}

/** isMenuActivationKey 的输入面（KeyboardEvent 子集）。 */
export interface MenuKeyEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/** Windows 菜单约定的稳定 mnemonic；不随界面语言变化。 */
const MENU_MNEMONICS: Record<MenubarMenuId, string> = {
  file: 'f',
  edit: 'e',
  view: 'v',
  window: 'w',
}

/**
 * Alt+mnemonic 命中：优先匹配稳定的 F/E/V/W（中文界面也保持 Windows
 * 用户熟悉的 Alt+F/E/V/W），同时接受当前标签首字符/全文。未命中返回 null。
 */
export function menuIdForMnemonic(key: string, labels: ApplicationMenuLabelSet): MenubarMenuId | null {
  const normalized = key.toLocaleLowerCase()
  for (const id of APPLICATION_MENU_ORDER) {
    const label = labels[id]
    if (normalized === MENU_MNEMONICS[id]
      || normalized === label.charAt(0).toLocaleLowerCase()
      || normalized === label.toLocaleLowerCase()) {
      return id
    }
  }
  return null
}

/** 是否为只激活菜单栏而不弹出 submenu 的键：单独 Alt 或 F10。 */
export function isMenuActivationKey(event: MenuKeyEvent): boolean {
  if (event.ctrlKey || event.metaKey) return false
  return event.key === 'F10' || event.key === 'Alt'
}

/** 已激活菜单的导航键（打开/位移/确认）。 */
export function isMenuNavigationKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowDown' || key === 'Enter' || key === ' '
}

export { applicationMenuLabels } from './locales.ts'