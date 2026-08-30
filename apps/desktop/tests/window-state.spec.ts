import { describe, expect, it } from 'vitest'
import { normalizeWindowState } from '../src/main/window-state-model'

const primary = { x: 0, y: 0, width: 1440, height: 900 }

describe('normalizeWindowState', () => {
  it('保留仍在当前显示器上的合法窗口', () => {
    expect(normalizeWindowState(
      { x: 100, y: 80, width: 1200, height: 700, isMaximized: true },
      [primary],
      primary,
    )).toEqual({ x: 100, y: 80, width: 1200, height: 700, isMaximized: true })
  })

  it('拔掉外接屏后居中回主显示器', () => {
    expect(normalizeWindowState(
      { x: 3000, y: 100, width: 1200, height: 700 },
      [primary],
      primary,
    )).toEqual({ x: 120, y: 100, width: 1200, height: 700 })
  })

  it('按窗口所在的高分辨率外接屏而非主屏限制尺寸', () => {
    const external = { x: 1440, y: 0, width: 2560, height: 1440 }
    expect(normalizeWindowState(
      { x: 1600, y: 100, width: 2000, height: 1100 },
      [primary, external],
      primary,
    )).toEqual({ x: 1600, y: 100, width: 2000, height: 1100 })
  })

  it('拒绝非有限值并约束最小尺寸', () => {
    expect(normalizeWindowState(
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 400, height: 10 },
      [primary],
      primary,
    )).toEqual({ x: 320, y: 150, width: 800, height: 600 })
  })
})
