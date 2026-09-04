import { describe, expect, it, vi } from 'vitest'
import type { BaseWindow, WebContents } from 'electron'
import {
  ApplicationMenuPopupController,
  buildApplicationMenuTemplate,
  isApplicationMenuId,
  isValidPopupAnchor,
  popupPointFor,
  type MenuLike,
} from '../src/main/application-menu'

function collectRoles(items: Array<{ role?: string; type?: string; submenu?: unknown }>, out: string[] = []): string[] {
  for (const item of items) {
    if (item.role !== undefined) out.push(item.role)
    if (item.submenu !== undefined) collectRoles(item.submenu as typeof items, out)
  }
  return out
}

describe('buildApplicationMenuTemplate', () => {
  it('固定四个顶级菜单：File/Edit/View/Window', () => {
    const template = buildApplicationMenuTemplate(false)
    expect(template.map(item => item.label)).toEqual(['File', 'Edit', 'View', 'Window'])
  })

  it('roles 覆盖：编辑/缩放/窗口全部走 Electron roles', () => {
    const roles = collectRoles(buildApplicationMenuTemplate(false))
    for (const role of ['quit', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'minimize', 'close']) {
      expect(roles).toContain(role)
    }
  })

  it('dev-only 项（reload/devtools）只在开发态出现', () => {
    const prodRoles = collectRoles(buildApplicationMenuTemplate(false))
    const devRoles = collectRoles(buildApplicationMenuTemplate(true))
    for (const role of ['reload', 'forceReload', 'toggleDevTools']) {
      expect(prodRoles).not.toContain(role)
      expect(devRoles).toContain(role)
    }
  })
})

describe('isApplicationMenuId / isValidPopupAnchor', () => {
  it('只接受闭合 id 集', () => {
    expect(isApplicationMenuId('file')).toBe(true)
    expect(isApplicationMenuId('window')).toBe(true)
    expect(isApplicationMenuId('help')).toBe(false)
    expect(isApplicationMenuId('')).toBe(false)
    expect(isApplicationMenuId(42)).toBe(false)
  })

  it('anchor 必须全有限且非负', () => {
    expect(isValidPopupAnchor({ x: 10, y: 10, width: 40, height: 24 })).toBe(true)
    expect(isValidPopupAnchor({ x: 0, y: 0, width: 0, height: 0 })).toBe(true)
    expect(isValidPopupAnchor({ x: Number.NaN, y: 10, width: 40, height: 24 })).toBe(false)
    expect(isValidPopupAnchor({ x: -1, y: 10, width: 40, height: 24 })).toBe(false)
    expect(isValidPopupAnchor({ x: 10, y: 10, width: 40 })).toBe(false)
    expect(isValidPopupAnchor(null)).toBe(false)
    expect(isValidPopupAnchor('nope')).toBe(false)
  })
})

describe('popupPointFor', () => {
  const anchor = { x: 10, y: 10, width: 40, height: 24 }

  it('zoom=1：x 用左缘、y 用底缘', () => {
    expect(popupPointFor(anchor, 1, [1000, 700])).toEqual({ x: 10, y: 34 })
  })

  it('zoom=1.5：CSS px 乘 zoom 换成窗口 DIP 后 round', () => {
    expect(popupPointFor(anchor, 1.5, [1000, 700])).toEqual({ x: 15, y: 51 })
  })

  it('越界 clamp 进内容区', () => {
    expect(popupPointFor({ x: 2000, y: 0, width: 40, height: 24 }, 1, [800, 600])).toEqual({ x: 799, y: 24 })
    expect(popupPointFor({ x: 0, y: 5000, width: 40, height: 24 }, 1, [800, 600])).toEqual({ x: 0, y: 599 })
  })

  it('zoom 异常按 1 处理', () => {
    expect(popupPointFor(anchor, 0, [1000, 700])).toEqual({ x: 10, y: 34 })
    expect(popupPointFor(anchor, Number.NaN, [1000, 700])).toEqual({ x: 10, y: 34 })
  })
})

function fakeMenu() {
  const popup = vi.fn()
  const closePopup = vi.fn()
  return { popup, closePopup, menu: { popup, closePopup } as unknown as MenuLike }
}

function fakeDeps(byId: Partial<Record<string, MenuLike>>) {
  return {
    menuById: (id: 'file' | 'edit' | 'view' | 'window'): MenuLike | null => byId[id] ?? null,
    closePopup: (menu: MenuLike): void => { menu.closePopup() },
  }
}

const win = { getContentSize: () => [1000, 700] } as unknown as BaseWindow
const contents = { getZoomFactor: () => 1 } as unknown as WebContents
const anchor = { x: 10, y: 10, width: 40, height: 24 }

describe('ApplicationMenuPopupController', () => {
  it('show：调用 Menu.popup（窗口 + 换算后坐标），isOpen 置位', () => {
    const file = fakeMenu()
    const controller = new ApplicationMenuPopupController(fakeDeps({ file: file.menu }))
    const onClosed = vi.fn()
    expect(controller.show('file', win, contents, anchor, onClosed)).toBe(true)
    expect(file.popup).toHaveBeenCalledWith(expect.objectContaining({ window: win, x: 10, y: 34 }))
    expect(controller.isOpen()).toBe(true)
  })

  it('切换菜单先 closePopup 前一个，再弹新的；旧 generation 回调被忽略', () => {
    const file = fakeMenu()
    const view = fakeMenu()
    const closed: string[] = []
    const controller = new ApplicationMenuPopupController(fakeDeps({ file: file.menu, view: view.menu }))
    controller.show('file', win, contents, anchor, id => { closed.push(id) })
    expect(controller.show('view', win, contents, anchor, id => { closed.push(id) })).toBe(true)
    expect(file.closePopup).toHaveBeenCalled()
    expect(view.popup).toHaveBeenCalled()
    const fileOptions = file.popup.mock.calls[0][0]
    fileOptions.callback?.()
    expect(closed).toEqual([])
    expect(controller.isOpen()).toBe(true)
  })

  it('同一 submenu 快速重开时，旧回调不会关闭新 popup', () => {
    const file = fakeMenu()
    const onClosed = vi.fn()
    const controller = new ApplicationMenuPopupController(fakeDeps({ file: file.menu }))
    controller.show('file', win, contents, anchor, onClosed)
    const firstOptions = file.popup.mock.calls[0][0]
    controller.show('file', win, contents, anchor, onClosed)
    firstOptions.callback?.()
    expect(onClosed).not.toHaveBeenCalled()
    expect(controller.isOpen()).toBe(true)
    const secondOptions = file.popup.mock.calls[1][0]
    secondOptions.callback?.()
    expect(onClosed).toHaveBeenCalledWith('file')
    expect(controller.isOpen()).toBe(false)
  })

  it('popup 关闭（callback）→ isOpen 复位并通知 onClosed', () => {
    const file = fakeMenu()
    const onClosed = vi.fn()
    const controller = new ApplicationMenuPopupController(fakeDeps({ file: file.menu }))
    controller.show('file', win, contents, anchor, onClosed)
    const options = file.popup.mock.calls[0][0]
    options.callback?.()
    expect(controller.isOpen()).toBe(false)
    expect(onClosed).toHaveBeenCalledWith('file')
  })

  it('非法 id / 非法 anchor / 无菜单 → false 且不弹出', () => {
    const file = fakeMenu()
    const controller = new ApplicationMenuPopupController(fakeDeps({ file: file.menu }))
    expect(controller.show('help' as 'file', win, contents, anchor, vi.fn())).toBe(false)
    expect(controller.show('file', win, contents, { x: Number.NaN, y: 0, width: 1, height: 1 }, vi.fn())).toBe(false)
    expect(controller.show('edit', win, contents, anchor, vi.fn())).toBe(false)
    expect(file.popup).not.toHaveBeenCalled()
  })
})