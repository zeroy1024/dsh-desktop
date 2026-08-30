import { describe, expect, it } from 'vitest'
import {
  fpsFromDeltas,
  frameIntervalFromDeltas,
  isJank,
  JANK_MS,
  jankThresholdFromDeltas,
  pushSample,
  type Sample,
} from '../src/fps.ts'

describe('fpsFromDeltas', () => {
  it('60Hz 均匀间隔得到 60', () => {
    const deltas = Array.from({ length: 30 }, () => 1000 / 60)
    expect(fpsFromDeltas(deltas)).toBeCloseTo(60, 5)
  })

  it('空窗口返回 null', () => {
    expect(fpsFromDeltas([])).toBeNull()
  })
})

describe('isJank', () => {
  it('超过两帧算掉帧', () => {
    expect(isJank(16.7)).toBe(false)
    expect(isJank(JANK_MS + 0.1)).toBe(true)
  })

  it('按 120Hz 实际刷新周期计算两帧阈值', () => {
    const deltas = Array.from({ length: 30 }, () => 1000 / 120)
    expect(frameIntervalFromDeltas(deltas)).toBeCloseTo(1000 / 120, 5)
    expect(jankThresholdFromDeltas(deltas)).toBeCloseTo(1000 / 60, 5)
    expect(isJank(20, jankThresholdFromDeltas(deltas))).toBe(true)
  })

  it('单个长帧不会污染刷新率中位数', () => {
    const deltas = [...Array.from({ length: 20 }, () => 1000 / 60), 90]
    expect(frameIntervalFromDeltas(deltas)).toBeCloseTo(1000 / 60, 5)
  })
})

describe('pushSample', () => {
  it('丢掉窗口外的旧样本', () => {
    const samples: Sample[] = []
    pushSample(samples, 1000, 16, 500)
    pushSample(samples, 1200, 16, 500)
    pushSample(samples, 1600, 16, 500)
    expect(samples.map((sample) => sample.at)).toEqual([1200, 1600])
  })
})
