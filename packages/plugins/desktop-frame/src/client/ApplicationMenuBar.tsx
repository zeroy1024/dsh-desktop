/**
 * ApplicationMenuBar.tsx — Windows 自绘顶级菜单栏（文件/编辑/视图/窗口）。
 *
 * 只画顶级标签 + 按键/鼠标交互；弹出的是主进程安装的同名 application
 * menu submenu（Menu.popup），renderer 只传闭合 menu id + anchor 矩形，
 * 不做任何菜单内容定义。
 *
 * 键盘模型：单独 Alt / F10 只聚焦菜单栏；Alt+F/E/V/W 直接打开；聚焦时
 * Left/Right 循环移动，Enter/Space/ArrowDown 打开，Escape 退出。popup
 * 打开后由系统菜单接管按键，关闭通知再清除页面高亮。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { desktopFrameT, isMenubarMenuId, type FrameLocaleStore, type MenubarMenuId } from './locales.ts'
import {
  APPLICATION_MENU_ORDER,
  isMenuActivationKey,
  isMenuNavigationKey,
  menuIdForMnemonic,
  nextMenuId,
} from './menu-model.ts'

function hostPlatform(): string {
  return window.dshDesktop?.platform ?? ''
}

export function ApplicationMenuBar({ frame }: { frame: FrameLocaleStore }) {
  const barRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<MenubarMenuId | null>(null)
  const [popupOpen, setPopupOpen] = useState(false)
  const activeRef = useRef<MenubarMenuId | null>(null)
  const popupOpenRef = useRef(false)
  const altOnlyRef = useRef(false)
  const snapshot = useSyncExternalStore(frame.subscribe, frame.getSnapshot)
  const labelsRef = useRef(snapshot.labels)
  labelsRef.current = snapshot.labels
  const labels = snapshot.labels

  const buttonFor = useCallback((id: MenubarMenuId): HTMLButtonElement | null => {
    const button = barRef.current?.querySelector(`[data-dsh-menu="${id}"]`)
    return button instanceof HTMLButtonElement ? button : null
  }, [])

  const activateMenu = useCallback((id: MenubarMenuId, focus: boolean): void => {
    activeRef.current = id
    setActive(id)
    if (focus) buttonFor(id)?.focus()
  }, [buttonFor])

  const clearMenu = useCallback((id?: MenubarMenuId): void => {
    if (id !== undefined && activeRef.current !== id) return
    activeRef.current = null
    popupOpenRef.current = false
    setActive(null)
    setPopupOpen(false)
  }, [])

  const openMenu = useCallback((id: MenubarMenuId): void => {
    const button = buttonFor(id)
    const rect = button?.getBoundingClientRect() ?? null
    const show = window.dshDesktop?.showApplicationMenu
    if (rect === null || show === undefined) {
      clearMenu(id)
      return
    }
    activateMenu(id, true)
    popupOpenRef.current = true
    setPopupOpen(true)
    void show(id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      .then((opened) => {
        if (!opened) clearMenu(id)
      })
      .catch(() => { clearMenu(id) })
  }, [activateMenu, buttonFor, clearMenu])

  useEffect(() => {
    const off = window.dshDesktop?.onApplicationMenuClosed?.((closedId) => {
      clearMenu(isMenubarMenuId(closedId) ? closedId : undefined)
    })
    return off ?? ((): void => {})
  }, [clearMenu])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (hostPlatform() !== 'win32') return
      if (event.key === 'Alt' && isMenuActivationKey(event)) {
        altOnlyRef.current = true
        event.preventDefault()
        return
      }
      if (event.key !== 'Alt') altOnlyRef.current = false

      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const id = menuIdForMnemonic(event.key, labelsRef.current)
        if (id !== null) {
          event.preventDefault()
          openMenu(id)
        }
        return
      }

      if (event.key === 'F10' && isMenuActivationKey(event)) {
        event.preventDefault()
        if (activeRef.current === null) activateMenu(APPLICATION_MENU_ORDER[0], true)
        else clearMenu()
        return
      }
      if (event.key === 'Escape') {
        if (activeRef.current !== null) {
          event.preventDefault()
          buttonFor(activeRef.current)?.blur()
          clearMenu()
        }
        return
      }
      const current = activeRef.current
      if (current === null || !isMenuNavigationKey(event.key)) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const next = nextMenuId(current, event.key === 'ArrowLeft' ? -1 : 1)
        if (popupOpenRef.current) openMenu(next)
        else activateMenu(next, true)
      } else {
        openMenu(current)
      }
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      if (hostPlatform() !== 'win32' || event.key !== 'Alt' || !altOnlyRef.current) return
      event.preventDefault()
      altOnlyRef.current = false
      if (activeRef.current === null) activateMenu(APPLICATION_MENU_ORDER[0], true)
      else clearMenu()
    }

    const onWindowBlur = (): void => {
      altOnlyRef.current = false
      // 原生 popup 可能抢走渲染进程焦点；打开期间交给 onApplicationMenuClosed。
      if (!popupOpenRef.current) clearMenu()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [activateMenu, buttonFor, clearMenu, openMenu])

  if (hostPlatform() !== 'win32') return null

  return (
    <div ref={barRef} data-dsh-menubar="" role="menubar" aria-label={desktopFrameT(snapshot.localeId, 'menubar.aria')}>
      {APPLICATION_MENU_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          data-dsh-menu={id}
          data-dsh-menu-active={active === id ? '' : undefined}
          aria-haspopup="menu"
          aria-expanded={popupOpen && active === id}
          aria-label={labels[id]}
          tabIndex={active === id ? 0 : -1}
          onFocus={() => { activateMenu(id, false) }}
          onClick={() => { openMenu(id) }}
          onMouseEnter={popupOpen && active !== id ? () => openMenu(id) : undefined}
        >
          {labels[id]}
        </button>
      ))}
    </div>
  )
}
