import { describe, expect, it, vi } from 'vitest'
import {
  redirectVerticalWheel,
  type HorizontalTabScroller,
  type HorizontalTabWheelEvent,
} from '../src/client/horizontal-wheel.ts'

function scroller(overrides: Partial<HorizontalTabScroller> = {}): HorizontalTabScroller {
  return { clientWidth: 100, scrollLeft: 0, scrollWidth: 300, ...overrides }
}

function wheel(overrides: Partial<HorizontalTabWheelEvent> = {}): HorizontalTabWheelEvent {
  return {
    ctrlKey: false,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 24,
    preventDefault: vi.fn(),
    ...overrides,
  }
}

describe('redirectVerticalWheel', () => {
  it('maps a vertical pixel wheel to horizontal movement', () => {
    const target = scroller()
    const event = wheel()

    expect(redirectVerticalWheel(target, event)).toBe(true)
    expect(target.scrollLeft).toBe(24)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('normalizes line and page wheel units', () => {
    const lines = scroller()
    redirectVerticalWheel(lines, wheel({ deltaMode: 1, deltaY: 3 }))
    expect(lines.scrollLeft).toBe(48)

    const pages = scroller()
    redirectVerticalWheel(pages, wheel({ deltaMode: 2, deltaY: 1 }))
    expect(pages.scrollLeft).toBe(100)
  })

  it('leaves horizontal-dominant trackpad input to native scrolling', () => {
    const target = scroller({ scrollLeft: 50 })
    const event = wheel({ deltaX: -30, deltaY: 4 })

    expect(redirectVerticalWheel(target, event)).toBe(false)
    expect(target.scrollLeft).toBe(50)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not consume pinch zoom or a strip without overflow', () => {
    const pinch = wheel({ ctrlKey: true })
    expect(redirectVerticalWheel(scroller(), pinch)).toBe(false)
    expect(pinch.preventDefault).not.toHaveBeenCalled()

    const noOverflow = wheel()
    expect(redirectVerticalWheel(scroller({ scrollWidth: 100 }), noOverflow)).toBe(false)
    expect(noOverflow.preventDefault).not.toHaveBeenCalled()
  })

  it('releases vertical scrolling to the parent at either horizontal edge', () => {
    const atStart = wheel({ deltaY: -20 })
    expect(redirectVerticalWheel(scroller(), atStart)).toBe(false)
    expect(atStart.preventDefault).not.toHaveBeenCalled()

    const atEnd = wheel({ deltaY: 20 })
    expect(redirectVerticalWheel(scroller({ scrollLeft: 200 }), atEnd)).toBe(false)
    expect(atEnd.preventDefault).not.toHaveBeenCalled()
  })
})
