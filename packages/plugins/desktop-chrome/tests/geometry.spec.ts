import { describe, expect, it } from 'vitest'
import { DARWIN_LEADING_PX, FALLBACK_LEADING_PX, titlebandLeadingPx, titlebandWidthPx } from '../src/geometry.ts'

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
    expect(titlebandWidthPx(280, false, 'darwin')).toBe(280)
  })

  it('折叠时至少盖住灯行控件', () => {
    expect(titlebandWidthPx(56, true, 'darwin')).toBe(172)
    expect(titlebandWidthPx(0, true, 'darwin')).toBe(172)
  })
})
