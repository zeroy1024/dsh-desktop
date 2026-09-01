import { useEffect, useRef, useState } from 'react'
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

/** 面板放大态（AppFrame 的 data-panel-expanded 标记，0006 补丁引入）。 */
function readPanelExpanded(): boolean {
  return document.querySelector('[data-panel-expanded]') !== null
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
  togglePanelExpand: () => void
}

export function createTitleband(actions: TitlebandProps) {
  return function DesktopTitleband() {
    return <Titleband {...actions} />
  }
}

export function Titleband({ toggleSidebar, startSession, togglePanel, togglePanelExpand }: TitlebandProps) {
  const titlebandRef = useRef<HTMLDivElement>(null)
  const geometryRef = useRef({ collapsed: false, width: 280, fullBleed: false, panelWidth: 0 })
  const [collapsed, setCollapsed] = useState(false)
  const [width, setWidth] = useState(280)
  const [fullBleed, setFullBleed] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  const [panelExpanded, setPanelExpanded] = useState(false)

  useEffect(() => {
    let raf = 0
    let sidebar: Element | null = null
    let panelCol: Element | null = null
    const applyTitlebandWidth = (): void => {
      const geometry = geometryRef.current
      const value = titlebandWidthPx(
        geometry.width, geometry.collapsed, platform(), geometry.fullBleed, geometry.panelWidth,
      )
      if (titlebandRef.current !== null) {
        titlebandRef.current.style.width = typeof value === 'number' ? `${value}px` : value
      }
    }
    const ro = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        // Preserve getBoundingClientRect's border-box semantics without a
        // synchronous geometry read. Chromium exposes borderBoxSize for every
        // ResizeObserver entry; contentRect is the compatibility fallback.
        const borderBox = Array.isArray(entry.borderBoxSize)
          ? entry.borderBoxSize[0]
          : entry.borderBoxSize
        const next = Math.round(borderBox?.inlineSize ?? entry.contentRect.width)
        if (entry.target === sidebar && next !== geometryRef.current.width) {
          geometryRef.current.width = next
          setWidth(next)
          changed = true
        } else if (entry.target === panelCol && next !== geometryRef.current.panelWidth) {
          // Panel width changes on every animation/drag frame. It affects only
          // this overlay box, so write the width directly instead of forcing
          // the titleband button subtree through a React render per frame.
          geometryRef.current.panelWidth = next
          changed = true
        }
      }
      if (changed) applyTitlebandWidth()
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
      const nextCollapsed = readCollapsed()
      const nextWidth = Math.round(readSidebarWidth())
      const nextPanelWidth = Math.round(readPanelWidth())
      const headerHeight = readCenterHeaderHeight()
      const nextFullBleed = headerHeight !== null && shouldStretchTitleband(true, headerHeight)
      geometryRef.current = {
        collapsed: nextCollapsed,
        width: nextWidth,
        fullBleed: nextFullBleed,
        panelWidth: nextPanelWidth,
      }
      setCollapsed(nextCollapsed)
      setWidth(nextWidth)
      setPanelCollapsed(readPanelCollapsed())
      setPanelExpanded(readPanelExpanded())
      // blank ↔ 会话态切换伴随 titleRow 子树增删，现有 childList observer
      // 已能捕获，无需扩大 attributeFilter（观察 class 会被官方高频写打满）。
      setFullBleed(nextFullBleed)
      applyTitlebandWidth()
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
      attributeFilter: ['data-sidebar-collapsed', 'data-panel-collapsed', 'data-panel-expanded'],
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
        ref={titlebandRef}
        data-dsh-titleband=""
        style={{
          width: titlebandWidthPx(
            width, collapsed, platform(), fullBleed, geometryRef.current.panelWidth,
          ),
        }}
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
      {/* 面板按钮簇钉在窗口 header 最右端（trailing 位）：不随 titleband 跟
          侧栏宽度走，面板开时正好落在 PanelShell header 预留的右端 88px 空位
          里。放大钮只在面板展开时存在（面板关着没有"放大"语义，也避免死
          状态）；拖动带延伸到右缘的中栏 header 之上，app-region 的挖洞只认
          显式 no-drag（默认值 none 不挖），漏掉这行点击会被拖动手势吞掉。 */}
      <div data-dsh-panel-cluster="">
        {!panelCollapsed && (
          <button
            type="button"
            data-dsh-panel-expand=""
            aria-label={panelExpanded ? 'Restore panel width' : 'Expand side panel'}
            title={panelExpanded ? '恢复面板宽度' : '放大面板'}
            onClick={() => {
              togglePanelExpand()
            }}
          >
            <PanelExpandIcon expanded={panelExpanded} />
          </button>
        )}
        <button
          type="button"
          data-dsh-panel-toggle=""
          aria-label={panelCollapsed ? 'Open side panel' : 'Close side panel'}
          aria-expanded={!panelCollapsed}
          title={panelCollapsed ? '打开面板' : '关闭面板'}
          onClick={() => {
            togglePanel()
          }}
        >
          <SidePanelIcon open={!panelCollapsed} />
        </button>
      </div>
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

/** 面板放大/恢复图标（Codex 同语义的对向双箭头，动作语义：箭头指向即点击
    后的流向）——未放大显示朝外双箭头（点击放大），放大态显示朝内双箭头
    （点击收回默认宽）。 */
function PanelExpandIcon({ expanded }: { expanded: boolean }) {
  const left = expanded ? 'M3.5 5l3 3-3 3' : 'M6.5 5 3.5 8l3 3'
  const right = expanded ? 'M12.5 5l-3 3 3 3' : 'M9.5 5l3 3-3 3'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={left} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={right} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
