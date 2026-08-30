/**
 * 给官方 hashed class 的侧栏打 data-dsh-chrome 标记，供 CSS 皮肤使用。
 * 锚点是稳定的 `data-shell-overlay`（AppFrame 明文属性，不是 CSS module）。
 */
export function markDesktopChrome(root: ParentNode): void {
  const overlay = root.querySelector('[data-shell-overlay]')
  const frame = overlay?.parentElement
  if (frame === null || frame === undefined) return
  frame.setAttribute('data-dsh-chrome', 'frame')

  const sidebarCol = frame.firstElementChild
  if (!(sidebarCol instanceof HTMLElement)) return
  sidebarCol.setAttribute('data-dsh-chrome', 'sidebar-col')

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
  sidebarSlot.removeAttribute('data-dsh-chrome')

  const sidebarRoot = sidebarSlot.firstElementChild
  if (!(sidebarRoot instanceof HTMLElement)) return
  sidebarRoot.setAttribute('data-dsh-chrome', 'sidebar-root')

  const logoRow = sidebarRoot.firstElementChild
  if (logoRow instanceof HTMLElement) {
    logoRow.setAttribute('data-dsh-chrome', 'logo-row')
    for (const button of logoRow.querySelectorAll('button')) {
      button.setAttribute(
        'data-dsh-chrome',
        button.hasAttribute('aria-expanded') ? 'toggle' : 'brand',
      )
    }
  }

  for (const button of sidebarRoot.querySelectorAll('button')) {
    if (button.closest('[data-dsh-chrome="logo-row"]') !== null) continue
    button.setAttribute('data-dsh-chrome', 'new-session')
    break
  }

  let taggedCenter = false
  for (const child of frame.children) {
    if (!(child instanceof HTMLElement)) continue
    if (child === sidebarCol) continue
    if (child.hasAttribute('data-shell-overlay')) continue
    if (child.getAttribute('data-side') !== null) continue
    if (child.getAttribute('data-dsh-chrome') === 'frame') continue
    child.setAttribute('data-dsh-chrome', taggedCenter ? 'details-col' : 'center-col')
    taggedCenter = true
  }
}
