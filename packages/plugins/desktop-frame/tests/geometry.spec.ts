import { describe, expect, it } from 'vitest'
import {
  FALLBACK_CLUSTER_PX,
  clusterWidthPx,
  shouldStretchTitleband,
  titlebandLeadingPx,
  titlebandWidthPx,
} from '../src/geometry.ts'

describe('titlebandLeadingPx', () => {
  it('darwin 给红绿灯留 92px', () => {
    expect(titlebandLeadingPx('darwin')).toBe(92)
  })

  it('其他平台 12px', () => {
    expect(titlebandLeadingPx('linux')).toBe(12)
    expect(titlebandLeadingPx('win32')).toBe(12)
  })
})

describe('clusterWidthPx', () => {
  it('优先真实测量值（含 Windows 菜单栏）', () => {
    expect(clusterWidthPx(248, 'win32')).toBe(248)
    expect(clusterWidthPx(160, 'darwin')).toBe(160)
  })

  it('测量缺失时按平台回落：darwin 92 + 按钮簇，其余 12 + 按钮簇', () => {
    expect(clusterWidthPx(0, 'darwin')).toBe(92 + FALLBACK_CLUSTER_PX)
    expect(clusterWidthPx(0, 'win32')).toBe(12 + FALLBACK_CLUSTER_PX)
    expect(clusterWidthPx(0, 'linux')).toBe(12 + FALLBACK_CLUSTER_PX)
  })
})

describe('titlebandWidthPx', () => {
  it('展开时跟侧栏宽度', () => {
    expect(titlebandWidthPx(280, false, 'darwin', false)).toBe(280)
  })

  it('折叠时盖住真实左簇，不再有 darwin 假灯区', () => {
    // darwin 折叠簇 92+80=172（与旧 FOLDED_CLUSTER_PX 等价）
    expect(titlebandWidthPx(0, true, 'darwin', false)).toBe(92 + FALLBACK_CLUSTER_PX)
    // win32 实测含菜单栏 248；测量缺失时按 12+80 回落
    expect(titlebandWidthPx(0, true, 'win32', false, 0, 248)).toBe(248)
    expect(titlebandWidthPx(0, true, 'win32', false)).toBe(12 + FALLBACK_CLUSTER_PX)
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