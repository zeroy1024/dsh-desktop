// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplicationMenuBar } from '../src/client/ApplicationMenuBar.tsx'
import { createFrameLocaleStore, type MenubarMenuId } from '../src/client/locales.ts'
import type { DesktopBridge } from '../src/client/types.ts'

let closeListener: ((id: MenubarMenuId) => void) | null = null
const showApplicationMenu = vi.fn(async () => true)

function installBridge(platform = 'win32'): void {
  const bridge: DesktopBridge = {
    platform,
    showApplicationMenu,
    onApplicationMenuClosed(listener) {
      closeListener = listener as (id: MenubarMenuId) => void
      return () => { closeListener = null }
    },
  }
  Object.defineProperty(window, 'dshDesktop', {
    configurable: true,
    writable: true,
    value: bridge,
  })
}

beforeEach(() => {
  closeListener = null
  showApplicationMenu.mockClear()
  installBridge()
})

afterEach(() => {
  cleanup()
  delete window.dshDesktop
})

describe('ApplicationMenuBar', () => {
  it('仅在 Windows 渲染本地化顶级菜单', () => {
    const frame = createFrameLocaleStore(() => 'zh')
    const mounted = render(<ApplicationMenuBar frame={frame} />)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['文件', '编辑', '视图', '窗口'])

    mounted.unmount()
    installBridge('darwin')
    render(<ApplicationMenuBar frame={frame} />)
    expect(screen.queryByRole('menubar')).toBeNull()
  })

  it('点击只发送闭合菜单 id 与按钮 anchor，关闭通知清理 active 状态', async () => {
    const frame = createFrameLocaleStore(() => 'zh')
    render(<ApplicationMenuBar frame={frame} />)
    const file = screen.getByRole('menuitem', { name: '文件' })
    fireEvent.click(file)

    await waitFor(() => { expect(showApplicationMenu).toHaveBeenCalledTimes(1) })
    expect(showApplicationMenu).toHaveBeenCalledWith('file', { x: 0, y: 0, width: 0, height: 0 })
    expect(file.hasAttribute('data-dsh-menu-active')).toBe(true)
    expect(file.getAttribute('aria-expanded')).toBe('true')

    act(() => { closeListener?.('file') })
    expect(file.hasAttribute('data-dsh-menu-active')).toBe(false)
    expect(file.getAttribute('aria-expanded')).toBe('false')
  })

  it('单独 Alt 只聚焦菜单栏，Alt+F 才弹出 File', async () => {
    const frame = createFrameLocaleStore(() => 'zh')
    render(<ApplicationMenuBar frame={frame} />)
    const file = screen.getByRole('menuitem', { name: '文件' })

    const altDown = new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true, cancelable: true })
    const altUp = new KeyboardEvent('keyup', { key: 'Alt', bubbles: true, cancelable: true })
    window.dispatchEvent(altDown)
    window.dispatchEvent(altUp)
    expect(altDown.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(file)
    expect(showApplicationMenu).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'f', altKey: true })
    await waitFor(() => { expect(showApplicationMenu).toHaveBeenCalledWith('file', expect.any(Object)) })
  })

  it('不吞掉无对应 mnemonic 的 Alt 组合键', () => {
    const frame = createFrameLocaleStore(() => 'en')
    render(<ApplicationMenuBar frame={frame} />)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(showApplicationMenu).not.toHaveBeenCalled()
  })
})
