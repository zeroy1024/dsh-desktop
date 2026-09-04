import { describe, expect, it } from 'vitest'
import { applicationMenuLabels, isMenubarMenuId } from '../src/client/locales.ts'
import {
  APPLICATION_MENU_ORDER,
  isMenuActivationKey,
  isMenuNavigationKey,
  menuIdForMnemonic,
  nextMenuId,
} from '../src/client/menu-model.ts'

describe('isMenubarMenuId', () => {
  it('只接受闭合顶级菜单 id', () => {
    expect(isMenubarMenuId('file')).toBe(true)
    expect(isMenubarMenuId('help')).toBe(false)
    expect(isMenubarMenuId('')).toBe(false)
    expect(isMenubarMenuId(null)).toBe(false)
  })
})

describe('applicationMenuLabels', () => {
  it('zh/en 字典各自完整，未知名回落 en', () => {
    expect(applicationMenuLabels('zh')).toEqual({ file: '文件', edit: '编辑', view: '视图', window: '窗口' })
    expect(applicationMenuLabels('en')).toEqual({ file: 'File', edit: 'Edit', view: 'View', window: 'Window' })
    expect(applicationMenuLabels('fr')).toEqual(applicationMenuLabels('en'))
  })
})

describe('nextMenuId', () => {
  it('左右循环位移', () => {
    expect(nextMenuId('file', 1)).toBe('edit')
    expect(nextMenuId('window', 1)).toBe('file')
    expect(nextMenuId('edit', -1)).toBe('file')
    expect(nextMenuId('file', -1)).toBe('window')
  })
})

describe('menuIdForMnemonic', () => {
  const en = applicationMenuLabels('en')
  const zh = applicationMenuLabels('zh')

  it('ASCII 标签按首字母大小写不敏感匹配', () => {
    expect(menuIdForMnemonic('f', en)).toBe('file')
    expect(menuIdForMnemonic('F', en)).toBe('file')
    expect(menuIdForMnemonic('w', en)).toBe('window')
    expect(menuIdForMnemonic('x', en)).toBeNull()
  })

  it('中文标签接受 F/E/V/W 稳定 mnemonic，也接受中文字形', () => {
    expect(menuIdForMnemonic('f', zh)).toBe('file')
    expect(menuIdForMnemonic('文', zh)).toBe('file')
    expect(menuIdForMnemonic('文件', zh)).toBe('file')
    expect(menuIdForMnemonic('窗', zh)).toBe('window')
  })
})

const key = (partial: Record<string, unknown>): Parameters<typeof isMenuActivationKey>[0] => ({
  key: '', altKey: false, ctrlKey: false, metaKey: false, ...partial,
} as never)

describe('isMenuActivationKey', () => {
  it('F10 与单独 Alt 只激活菜单栏', () => {
    expect(isMenuActivationKey(key({ key: 'F10' }))).toBe(true)
    expect(isMenuActivationKey(key({ key: 'Alt', altKey: true }))).toBe(true)
  })

  it('Alt+mnemonic、Ctrl/⌘ 组合与普通键不属于单纯激活键', () => {
    expect(isMenuActivationKey(key({ key: 'f', altKey: true }))).toBe(false)
    expect(isMenuActivationKey(key({ key: 'f', ctrlKey: true }))).toBe(false)
    expect(isMenuActivationKey(key({ key: 'f', metaKey: true }))).toBe(false)
    expect(isMenuActivationKey(key({ key: 'Tab' }))).toBe(false)
  })
})

describe('isMenuNavigationKey', () => {
  it('识别已激活菜单的导航键', () => {
    expect(isMenuNavigationKey('ArrowLeft')).toBe(true)
    expect(isMenuNavigationKey('ArrowRight')).toBe(true)
    expect(isMenuNavigationKey('ArrowDown')).toBe(true)
    expect(isMenuNavigationKey('ArrowUp')).toBe(false)
    expect(isMenuNavigationKey('Enter')).toBe(true)
    expect(isMenuNavigationKey(' ')).toBe(true)
    expect(isMenuNavigationKey('Escape')).toBe(false)
    expect(isMenuNavigationKey('x')).toBe(false)
  })
})

describe('APPLICATION_MENU_ORDER', () => {
  it('与主进程模板顺序一致：file/edit/view/window', () => {
    expect(APPLICATION_MENU_ORDER).toEqual(['file', 'edit', 'view', 'window'])
  })
})