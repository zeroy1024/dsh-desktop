// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { observeContentEnd } from '../src/client/content-end.ts'

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('measures new buttons and locale width changes through the latest geometry ref', async () => {
  const observed = new Set<Element>()
  let resize!: () => void
  let raf: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { raf = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { raf = undefined })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe(node: Element): void { observed.add(node) }
    unobserve(node: Element): void { observed.delete(node) }
    disconnect(): void { observed.clear() }
  })
  const flush = (): void => { const callback = raf; raf = undefined; callback?.(0) }
  const container = document.createElement('div')
  const menu = document.createElement('div')
  menu.dataset.dshMenubar = ''
  container.append(menu)
  document.body.append(container)
  let right = 130
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ left: 10 } as DOMRect)
  vi.spyOn(menu, 'getBoundingClientRect').mockImplementation(() => ({ right }) as DOMRect)
  const geometry = { current: { contentEnd: 0 } }
  const apply = vi.fn(() => geometry.current.contentEnd)
  const dispose = observeContentEnd(container, geometry, apply)
  try {
    expect(geometry.current.contentEnd).toBe(120)
    expect(observed.has(menu)).toBe(true)
    geometry.current = { contentEnd: 120 }
    right = 180
    resize()
    flush()
    expect(geometry.current.contentEnd).toBe(170)
    expect(apply).toHaveLastReturnedWith(170)
    const button = document.createElement('button')
    button.dataset.dshClusterButton = ''
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ right: 220 } as DOMRect)
    container.append(button)
    await Promise.resolve()
    flush()
    expect(observed.has(button)).toBe(true)
    expect(geometry.current.contentEnd).toBe(210)
    button.remove()
    await Promise.resolve()
    flush()
    expect(observed.has(button)).toBe(false)
    expect(geometry.current.contentEnd).toBe(170)
  } finally { dispose() }
  expect(observed.size).toBe(0)
  expect(document.documentElement.style.getPropertyValue('--dsh-titleband-content-end')).toBe('')
})
