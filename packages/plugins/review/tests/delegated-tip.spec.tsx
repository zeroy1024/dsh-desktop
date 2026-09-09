// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDelegatedTip } from '../src/client/delegated-tip.tsx'

afterEach(cleanup)

function Harness({ label = '针对此行写审查意见' }: { label?: string }) {
  const { bind, bubble } = useDelegatedTip(label, 0)
  return (
    <div>
      <button type="button" data-diff-tip="" aria-label={label} data-id="a" {...bind}>A</button>
      <button type="button" data-diff-tip="" aria-label={label} data-id="b" {...bind}>B</button>
      <span>not a tip</span>
      {bubble}
    </div>
  )
}

function stubRect(el: HTMLElement, left: number): void {
  el.getBoundingClientRect = () => ({
    x: left, y: 20, left, top: 20, right: left + 18, bottom: 38, width: 18, height: 18, toJSON() { return {} },
  })
}

describe('useDelegatedTip', () => {
  it('悬停后只挂一个气泡，离开即收', () => {
    render(<Harness />)
    const a = screen.getByText('A')
    stubRect(a, 10)
    fireEvent.mouseOver(a)
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toBe('针对此行写审查意见')
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
    fireEvent.mouseOut(a, { relatedTarget: screen.getByText('not a tip') })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('在两枚按钮间移动时仍只有一个气泡', () => {
    render(<Harness />)
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    stubRect(a, 10)
    stubRect(b, 40)
    fireEvent.mouseOver(a)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.mouseOut(a, { relatedTarget: b })
    fireEvent.mouseOver(b)
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  })
})
