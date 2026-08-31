/**
 * 给官方 hashed class 的侧栏打 data-dsh-frame 标记，供桌面窗框 CSS 使用。
 * 锚点是稳定的 `data-shell-overlay`（AppFrame 明文属性，不是 CSS module）。
 */
export function markDesktopFrame(root: ParentNode): void {
  const overlay = root.querySelector('[data-shell-overlay]')
  const frame = overlay?.parentElement
  if (frame === null || frame === undefined) return
  frame.setAttribute('data-dsh-frame', 'frame')

  const sidebarCol = frame.firstElementChild
  if (!(sidebarCol instanceof HTMLElement)) return
  sidebarCol.setAttribute('data-dsh-frame', 'sidebar-col')

  // 中列/详情列标记不依赖侧栏内部结构，放在 slot 查找之前：侧栏 DOM 一变
  // 只牺牲侧栏皮肤，中列实底失标会透出 vibrancy，不能跟着挂。
  // 面板列（0006 缝引入的第三个子元素）按其内部槽包装的明文 data-slot="panel"
  // 判定，独立于顺序——误标成 details-col 会把 details 的样式规则应用到面板列。
  let taggedCenter = false
  for (const child of frame.children) {
    if (!(child instanceof HTMLElement)) continue
    if (child === sidebarCol) continue
    if (child.hasAttribute('data-shell-overlay')) continue
    if (child.getAttribute('data-side') !== null) continue
    if (child.getAttribute('data-dsh-frame') === 'frame') continue
    if (child.querySelector('[data-slot="panel"]') !== null) {
      child.setAttribute('data-dsh-frame', 'panel-col')
      continue
    }
    child.setAttribute('data-dsh-frame', taggedCenter ? 'details-col' : 'center-col')
    taggedCenter = true
  }

  // ui-renderer 会在每个槽外包一层稳定的
  // <div data-slot="sidebar" style="display: contents">。这个锚点不是 SidebarRoot；
  // 直接取 sidebarCol.firstElementChild 会把真正的 SidebarRoot 误标为 logo-row，
  // 随后的 display:none 会隐藏整列。
  const sidebarSlot = [...sidebarCol.children].find(
    (child): child is HTMLElement => child instanceof HTMLElement
      && child.getAttribute('data-slot') === 'sidebar',
  )
  if (sidebarSlot === undefined) return
  // 清掉旧版热替换可能留在 display:contents 锚点上的错误标记。
  sidebarSlot.removeAttribute('data-dsh-frame')

  const sidebarRoot = sidebarSlot.firstElementChild
  if (!(sidebarRoot instanceof HTMLElement)) return
  sidebarRoot.setAttribute('data-dsh-frame', 'sidebar-root')

  const logoRow = sidebarRoot.firstElementChild
  if (logoRow instanceof HTMLElement) {
    logoRow.setAttribute('data-dsh-frame', 'logo-row')
    for (const button of logoRow.querySelectorAll('button')) {
      button.setAttribute(
        'data-dsh-frame',
        button.hasAttribute('aria-expanded') ? 'toggle' : 'brand',
      )
    }
  }

  for (const button of sidebarRoot.querySelectorAll('button')) {
    if (button.closest('[data-dsh-frame="logo-row"]') !== null) continue
    button.setAttribute('data-dsh-frame', 'new-session')
    break
  }
}
