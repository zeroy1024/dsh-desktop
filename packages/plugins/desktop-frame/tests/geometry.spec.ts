import { describe, expect, it } from 'vitest'
import {
  DARWIN_LEADING_PX,
  FALLBACK_LEADING_PX,
  shouldStretchTitleband,
  titlebandLeadingPx,
  titlebandWidthPx,
} from '../src/geometry.ts'

describe('titlebandLeadingPx', () => {
  it('darwin 给红绿灯留 92px', () => {
    expect(titlebandLeadingPx('darwin')).toBe(DARWIN_LEADING_PX)
  })

  it('其他平台 12px', () => {
    expect(titlebandLeadingPx('linux')).toBe(FALLBACK_LEADING_PX)
    expect(titlebandLeadingPx('win32')).toBe(FALLBACK_LEADING_PX)
  })
})

describe('titlebandWidthPx', () => {
  it('展开时跟侧栏宽度', () => {
    expect(titlebandWidthPx(280, false, 'darwin', false)).toBe(280)
  })

  it('折叠时至少盖住灯行控件', () => {
    expect(titlebandWidthPx(56, true, 'darwin', false)).toBe(172)
    expect(titlebandWidthPx(0, true, 'darwin', false)).toBe(172)
  })

  it('fullBleed 时铺满整窗，优先于折叠与平台', () => {
    expect(titlebandWidthPx(280, false, 'darwin', true)).toBe('100%')
    expect(titlebandWidthPx(0, true, 'linux', true)).toBe('100%')
  })

  it('fullBleed + 面板开：拖动带让出面板列；面板关恢复全宽', () => {
    expect(titlebandWidthPx(280, false, 'darwin', true, 400)).toBe('calc(100% - 400px)')
    expect(titlebandWidthPx(56, true, 'darwin', true, 320)).toBe('calc(100% - 320px)')
    // 面板关（观察宽 0）退回现状；未传参的既有调用同理。
    expect(titlebandWidthPx(280, false, 'darwin', true, 0)).toBe('100%')
  })
})

describe('shouldStretchTitleband', () => {
  it('皮肤标记缺失时保守降级为侧栏宽', () => {
    expect(shouldStretchTitleband(false, 0)).toBe(false)
    expect(shouldStretchTitleband(false, 44)).toBe(false)
  })

  it('header 可见（会话态）时不铺满', () => {
    expect(shouldStretchTitleband(true, 44)).toBe(false)
    expect(shouldStretchTitleband(true, 1)).toBe(false)
  })

  it('header 隐藏（blank 态 rect 为 0）时铺满', () => {
    expect(shouldStretchTitleband(true, 0)).toBe(true)
  })
})
