import { useEffect, useState } from 'react'
import { shouldStretchTitleband, titlebandWidthPx } from '../geometry.ts'
import { markDesktopFrame } from '../mark.ts'

function platform(): string {
  return window.dshDesktop?.platform ?? ''
}

function readCollapsed(): boolean {
  return document.querySelector('[data-sidebar-collapsed]') !== null
}

function readSidebarWidth(): number {
  const col = document.querySelector('[data-dsh-frame="sidebar-col"]')
  if (!(col instanceof HTMLElement)) return 280
  return col.getBoundingClientRect().width
}

/** 面板列开合态（AppFrame 的 data-panel-collapsed 标记，0006 补丁引入）。 */
function readPanelCollapsed(): boolean {
  return document.querySelector('[data-panel-collapsed]') !== null
}

/** 面板列渲染宽（markDesktopFrame 打的 panel-col 标记；未标/未开时为 0）。 */
function readPanelWidth(): number {
  const col = document.querySelector('[data-dsh-frame="panel-col"]')
  if (!(col instanceof HTMLElement)) return 0
  return col.getBoundingClientRect().width
}

/**
 * 中栏 header 的可见高度（blank 态上游只 display:none，元素常驻，rect 为 0）。
 * 返回 null 表示皮肤标记未生效或 header 不存在——顶带保持侧栏宽保守降级。
 */
function readCenterHeaderHeight(): number | null {
  const col = document.querySelector('[data-dsh-frame="center-col"]')
  if (!(col instanceof HTMLElement)) return null
  const header = col.querySelector('header')
  if (!(header instanceof HTMLElement)) return null
  return header.getBoundingClientRect().height
}

export interface TitlebandProps {
  toggleSidebar: () => void
  startSession: () => void
  togglePanel: () => void
}

export function createTitleband(actions: TitlebandProps) {
  return function DesktopTitleband() {
    return <Titleband {...actions} />
  }
}

export function Titleband({ toggleSidebar, startSession, togglePanel }: TitlebandProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(280)
  const [fullBleed, setFullBleed] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  const [panelWidth, setPanelWidth] = useState(0)

  useEffect(() => {
    let raf = 0
    let sidebar: Element | null = null
    let panelCol: Element | null = null
    const ro = new ResizeObserver(() => {
      setWidth(Math.round(readSidebarWidth()))
      setPanelWidth(Math.round(readPanelWidth()))
    })

    const watchSidebar = (): void => {
      const col = document.querySelector('[data-dsh-frame="sidebar-col"]')
      if (col === sidebar) return
      if (sidebar !== null) ro.unobserve(sidebar)
      sidebar = col
      if (col instanceof HTMLElement) ro.observe(col)
    }
    // 面板列宽度驱动 blank 态拖动带的让位（calc(100% - 面板宽)）；开合/拖拽/
    // 让位的终值都由 RO 捕获，无需复算让位链。
    const watchPanel = (): void => {
      const col = document.querySelector('[data-dsh-frame="panel-col"]')
      if (col === panelCol) return
      if (panelCol !== null) ro.unobserve(panelCol)
      panelCol = col
      if (col instanceof HTMLElement) ro.observe(col)
    }

    const sync = (): void => {
      markDesktopFrame(document)
      watchSidebar()
      watchPanel()
      setCollapsed(readCollapsed())
      setWidth(Math.round(readSidebarWidth()))
      setPanelWidth(Math.round(readPanelWidth()))
      setPanelCollapsed(readPanelCollapsed())
      // blank ↔ 会话态切换伴随 titleRow 子树增删，现有 childList observer
      // 已能捕获，无需扩大 attributeFilter（观察 class 会被官方高频写打满）。
      const headerHeight = readCenterHeaderHeight()
      setFullBleed(headerHeight !== null && shouldStretchTitleband(true, headerHeight))
    }

    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        sync()
      })
    }

    sync()
    // 只盯折叠标记和子树结构。不能观察 style/class/data-dsh-frame：
    // 官方 AppFrame 每帧写 gridTemplateColumns，我们自己也写 titleband width，
    // 会和 markDesktopFrame 互相触发，把渲染进程打满。
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed', 'data-panel-collapsed'],
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
    <>
      <div
        data-dsh-titleband=""
        style={{ width: titlebandWidthPx(width, collapsed, platform(), fullBleed, panelWidth) }}
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
      {/* 面板开关钉在窗口 header 最右端（trailing 位）：不随 titleband 跟侧栏
          宽度走，面板开时正好落在 PanelShell header 预留的右端空位里。 */}
      <button
        type="button"
        data-dsh-panel-toggle=""
        aria-label={panelCollapsed ? 'Open side panel' : 'Close side panel'}
        aria-expanded={!panelCollapsed}
        onClick={() => {
          togglePanel()
        }}
      >
        <SidePanelIcon open={!panelCollapsed} />
      </button>
    </>
  )
}

function PanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {collapsed ? (
        // 折叠后侧栏收进 0 轨，面板边线贴左缘；展开时边线示意在左栏右侧。
        <path d="M4 2.5v11" stroke="currentColor" strokeWidth="1.2" />
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

/** 右侧面板开关图标：矩形外壳 + 右列竖线（开态高亮竖线示意面板展开）。 */
function SidePanelIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.5 2.5v11"
        stroke="currentColor"
        strokeWidth={open ? 2 : 1.2}
      />
    </svg>
  )
}
