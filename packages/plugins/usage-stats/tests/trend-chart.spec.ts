import { describe, expect, it } from 'vitest'
import { enumerateTrailingDays } from '../src/client/trend-range.ts'

describe('enumerateTrailingDays', () => {
  it('以当天为右端，返回连续 count 个本地日期键', () => {
    const end = new Date(2026, 8, 6, 21, 0, 0).getTime()
    expect(enumerateTrailingDays(end, 7)).toEqual([
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ])
    expect(enumerateTrailingDays(end, 30)).toHaveLength(30)
    expect(enumerateTrailingDays(end, 30)[0]).toBe('2026-08-08')
    expect(enumerateTrailingDays(end, 30)[29]).toBe('2026-09-06')
  })
})
