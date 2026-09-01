/** Pure wheel-to-horizontal-scroll policy shared by tab-strip UI hooks. */

const LINE_HEIGHT_PX = 16
const EDGE_EPSILON_PX = 0.5

/** Structural wheel shape keeps the redirector independently unit-testable. */
export interface HorizontalTabWheelEvent {
  ctrlKey: boolean
  defaultPrevented?: boolean
  deltaMode: number
  deltaX: number
  deltaY: number
  preventDefault: () => void
}

/** Minimal scroll surface consumed by the wheel redirector. */
export interface HorizontalTabScroller {
  clientWidth: number
  scrollLeft: number
  scrollWidth: number
}

/** Convert vertical wheel units (pixels / lines / pages) into CSS pixels. */
function verticalDeltaPx(event: HorizontalTabWheelEvent, pageWidth: number): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT_PX
  if (event.deltaMode === 2) return event.deltaY * pageWidth
  return event.deltaY
}

/**
 * Redirect a vertical-dominant wheel gesture into the horizontal tab strip.
 * Returns true only when the event was consumed.
 *
 * Horizontal-dominant gestures deliberately return false: an overflow-x:auto
 * element handles those natively, including macOS trackpad momentum. Pinch
 * zoom (reported as ctrl+wheel by Chromium) also remains untouched.
 */
export function redirectVerticalWheel(
  scroller: HorizontalTabScroller,
  event: HorizontalTabWheelEvent,
): boolean {
  if (event.defaultPrevented === true || event.ctrlKey || event.deltaY === 0) return false
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false

  const delta = verticalDeltaPx(event, scroller.clientWidth)
  if (delta === 0) return false

  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
  const canMove = delta < 0
    ? scroller.scrollLeft > EDGE_EPSILON_PX
    : scroller.scrollLeft < maxScrollLeft - EDGE_EPSILON_PX
  if (!canMove) return false

  event.preventDefault()
  scroller.scrollLeft += delta
  return true
}
