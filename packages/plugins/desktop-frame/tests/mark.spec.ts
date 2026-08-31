import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { markDesktopFrame } from '../src/mark.ts'

class FakeElement {
  parentElement: FakeElement | null = null
  readonly children: FakeElement[] = []
  private readonly attributes = new Map<string, string>()

  constructor(readonly tagName = 'DIV') {}

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (selector === '[data-shell-overlay]' && child.hasAttribute('data-shell-overlay')) return child
      const nested = child.querySelector(selector)
      if (nested !== null) return nested
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = []
    for (const child of this.children) {
      if (selector === 'button' && child.tagName === 'BUTTON') matches.push(child)
      matches.push(...child.querySelectorAll(selector))
    }
    return matches
  }

  closest(selector: string): FakeElement | null {
    if (
      selector === '[data-dsh-frame="logo-row"]'
      && this.getAttribute('data-dsh-frame') === 'logo-row'
    ) return this
    return this.parentElement?.closest(selector) ?? null
  }
}

const originalHTMLElement = Reflect.get(globalThis, 'HTMLElement')

beforeAll(() => {
  Object.defineProperty(globalThis, 'HTMLElement', { value: FakeElement, configurable: true })
})

afterAll(() => {
  if (originalHTMLElement === undefined) Reflect.deleteProperty(globalThis, 'HTMLElement')
  else Object.defineProperty(globalThis, 'HTMLElement', { value: originalHTMLElement, configurable: true })
})

describe('markDesktopFrame', () => {
  it('跳过 display:contents 的 sidebar slot 锚点，只把真实首行标成 logo-row', () => {
    const documentRoot = new FakeElement()
    const frame = new FakeElement()
    const sidebarCol = new FakeElement()
    const centerCol = new FakeElement()
    const overlay = new FakeElement()
    overlay.setAttribute('data-shell-overlay', '')

    const sidebarSlot = new FakeElement()
    sidebarSlot.setAttribute('data-slot', 'sidebar')
    // 模拟旧版热替换留下的错误标记。
    sidebarSlot.setAttribute('data-dsh-frame', 'sidebar-root')
    const sidebarRoot = new FakeElement()
    const logoRow = new FakeElement()
    const brandButton = new FakeElement('BUTTON')
    const toggleButton = new FakeElement('BUTTON')
    toggleButton.setAttribute('aria-expanded', 'true')
    logoRow.append(brandButton, toggleButton)
    const newSession = new FakeElement('BUTTON')
    const region = new FakeElement()
    sidebarRoot.append(logoRow, newSession, region)
    sidebarSlot.append(sidebarRoot)
    sidebarCol.append(sidebarSlot)
    frame.append(sidebarCol, centerCol, overlay)
    documentRoot.append(frame)

    markDesktopFrame(documentRoot as unknown as ParentNode)

    expect(frame.getAttribute('data-dsh-frame')).toBe('frame')
    expect(sidebarCol.getAttribute('data-dsh-frame')).toBe('sidebar-col')
    expect(sidebarSlot.getAttribute('data-dsh-frame')).toBeNull()
    expect(sidebarRoot.getAttribute('data-dsh-frame')).toBe('sidebar-root')
    expect(logoRow.getAttribute('data-dsh-frame')).toBe('logo-row')
    expect(newSession.getAttribute('data-dsh-frame')).toBe('new-session')
    expect(centerCol.getAttribute('data-dsh-frame')).toBe('center-col')
  })

  it('没有 data-shell-overlay 锚点时不落任何标记', () => {
    const documentRoot = new FakeElement()
    const frame = new FakeElement()
    const sidebarCol = new FakeElement()
    frame.append(sidebarCol)
    documentRoot.append(frame)

    markDesktopFrame(documentRoot as unknown as ParentNode)

    expect(frame.getAttribute('data-dsh-frame')).toBeNull()
    expect(sidebarCol.getAttribute('data-dsh-frame')).toBeNull()
  })

  it('找不到 sidebar slot 时不把 SidebarRoot 误标为 logo-row，中列标记照常', () => {
    const documentRoot = new FakeElement()
    const frame = new FakeElement()
    const sidebarCol = new FakeElement()
    const centerCol = new FakeElement()
    const overlay = new FakeElement()
    overlay.setAttribute('data-shell-overlay', '')
    const sidebarRoot = new FakeElement()
    sidebarCol.append(sidebarRoot)
    frame.append(sidebarCol, centerCol, overlay)
    documentRoot.append(frame)

    markDesktopFrame(documentRoot as unknown as ParentNode)

    expect(frame.getAttribute('data-dsh-frame')).toBe('frame')
    expect(sidebarCol.getAttribute('data-dsh-frame')).toBe('sidebar-col')
    expect(sidebarRoot.getAttribute('data-dsh-frame')).toBeNull()
    expect(centerCol.getAttribute('data-dsh-frame')).toBe('center-col')
  })
})
