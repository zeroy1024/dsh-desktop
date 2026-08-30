import { useEffect, useState } from 'react'
import { titlebandWidthPx } from '../geometry.ts'
import { markDesktopChrome } from '../mark.ts'

function platform(): string {
  return window.dshDesktop?.platform ?? ''
}

function readCollapsed(): boolean {
  return document.querySelector('[data-sidebar-collapsed]') !== null
}

function readSidebarWidth(): number {
  const col = document.querySelector('[data-dsh-chrome="sidebar-col"]')
  if (!(col instanceof HTMLElement)) return 280
  return col.getBoundingClientRect().width
}

export interface TitlebandProps {
  toggleSidebar: () => void
  startSession: () => void
}

export function createTitleband(actions: TitlebandProps) {
  return function DesktopTitleband() {
    return <Titleband {...actions} />
  }
}

export function Titleband({ toggleSidebar, startSession }: TitlebandProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(280)

  useEffect(() => {
    let raf = 0
    let sidebar: Element | null = null
    const ro = new ResizeObserver(() => {
      setWidth(Math.round(readSidebarWidth()))
    })

    const watchSidebar = (): void => {
      const col = document.querySelector('[data-dsh-chrome="sidebar-col"]')
      if (col === sidebar) return
      if (sidebar !== null) ro.unobserve(sidebar)
      sidebar = col
      if (col instanceof HTMLElement) ro.observe(col)
    }

    const sync = (): void => {
      markDesktopChrome(document)
      watchSidebar()
      setCollapsed(readCollapsed())
      setWidth(Math.round(readSidebarWidth()))
    }

    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        sync()
      })
    }

    sync()
    // 只盯折叠标记和子树结构。不能观察 style/class/data-dsh-chrome：
    // 官方 AppFrame 每帧写 gridTemplateColumns，我们自己也写 titleband width，
    // 会和 markDesktopChrome 互相触发，把渲染进程打满。
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed'],
    })
    window.addEventListener('resize', schedule)
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      observer.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [])

  return (
    <div
      data-dsh-titleband=""
      style={{ width: titlebandWidthPx(width, collapsed, platform()) }}
    >
      <button
        type="button"
        aria-label={collapsed ? 'Open sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        onClick={() => {
          toggleSidebar()
        }}
      >
        <PanelIcon collapsed={collapsed} />
      </button>
      {collapsed ? (
        <button
          type="button"
          aria-label="New session"
          onClick={() => {
            startSession()
          }}
        >
          <PlusIcon />
        </button>
      ) : null}
    </div>
  )
}

function PanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {collapsed ? (
        <path d="M6.5 2.5v11" stroke="currentColor" strokeWidth="1.2" />
      ) : (
        <path d="M6.5 2.5v11" stroke="currentColor" strokeWidth="1.2" />
      )}
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
