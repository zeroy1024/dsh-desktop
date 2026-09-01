/**
 * Scroll behavior shared by the panel-page and file-preview tab strips.
 * Native horizontal wheel/trackpad input is left to Chromium so momentum is
 * preserved; vertical-dominant wheel input is redirected only while the strip
 * still has room to move in that direction.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { redirectVerticalWheel } from './horizontal-wheel.ts'

/** Avoid geometry reads while the parent panel's width transition is active. */
const REVEAL_AFTER_RESIZE_MS = 80

/** Keep the active tab visible without moving any vertical ancestor. */
function revealActiveTab(scroller: HTMLElement): void {
  const active = scroller.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  if (active === null) return

  const viewport = scroller.getBoundingClientRect()
  const tab = active.getBoundingClientRect()
  if (tab.left < viewport.left) {
    scroller.scrollLeft += tab.left - viewport.left
  } else if (tab.right > viewport.right) {
    scroller.scrollLeft += tab.right - viewport.right
  }
}

/**
 * Attach wheel redirection and active-tab reveal behavior to one tablist.
 * `itemCount` lets the effect attach when a conditionally rendered strip goes
 * from empty to populated without re-registering for every added tab.
 */
export function useHorizontalTabScroll<T extends HTMLElement>(
  activeKey: string | null | undefined,
  itemCount: number,
): RefObject<T> {
  const ref = useRef<T>(null)
  const populated = itemCount > 0

  useEffect(() => {
    const scroller = ref.current
    if (scroller === null) return

    // The panel column animates its width on open/close and fullscreen restore.
    // A ResizeObserver on the tab strip consequently fires once per animation
    // frame. Defer the visibility check until the resize settles: reading two
    // client rects for every frame adds avoidable layout work, while the native
    // strip remains usable throughout the transition. Active-tab changes still
    // reveal synchronously in the layout effect below.
    let revealTimer: number | null = null
    const scheduleReveal = (): void => {
      if (revealTimer !== null) window.clearTimeout(revealTimer)
      revealTimer = window.setTimeout(() => {
        revealTimer = null
        revealActiveTab(scroller)
      }, REVEAL_AFTER_RESIZE_MS)
    }

    const onWheel = (event: WheelEvent): void => {
      redirectVerticalWheel(scroller, event)
    }
    // preventDefault is conditional, so this listener cannot be passive.
    scroller.addEventListener('wheel', onWheel, { passive: false })

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleReveal)
    observer?.observe(scroller)

    return () => {
      observer?.disconnect()
      if (revealTimer !== null) window.clearTimeout(revealTimer)
      scroller.removeEventListener('wheel', onWheel)
    }
  }, [populated])

  useLayoutEffect(() => {
    if (ref.current !== null) revealActiveTab(ref.current)
  }, [activeKey, itemCount])

  return ref
}
