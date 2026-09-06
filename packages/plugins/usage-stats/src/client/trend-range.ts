import { localDateKey } from '../aggregator.ts'

export type RangeKey = 7 | 30

/**
 * 以 endMs 所在本地日历日为右端，往回数 count 个连续日期键（含当天）。
 * 用「年月日相减」而不是毫秒差，避免 DST 让某一天被跳过或重复。
 */
export function enumerateTrailingDays(endMs: number, count: number): string[] {
  const end = new Date(endMs)
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const days: string[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(last.getFullYear(), last.getMonth(), last.getDate() - offset)
    days.push(localDateKey(date.getTime()))
  }
  return days
}
