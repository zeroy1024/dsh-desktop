/**
 * 展示格式化：全部走 Intl 并跟随页面 locale（archive-manager 同款取向）。
 * formatter 每次现建——调用频率低，换取 locale 切换即时生效。
 */

/** 缩写尾数：≥100 取整、其余保留 1 位小数。 */
function compactMantissa(scaled: number): string {
  const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return String(rounded)
}

/** 大数紧凑形式：K/M/B 缩写，1 位小数封顶（2,189,000 → 2.2M、408,718 → 409K）。 */
export function formatTokensCompact(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e9) return `${compactMantissa(value / 1e9)}B`
  if (absolute >= 1e6) return `${compactMantissa(value / 1e6)}M`
  if (absolute >= 1e3) return `${compactMantissa(value / 1e3)}K`
  return String(value)
}

/** 明细表全量形式（千分位）。 */
export function formatTokensFull(value: number): string {
  return value.toLocaleString(undefined)
}

/** 比例（0-1）；无分母时为 undefined → 「—」。 */
export function formatPercent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

/** 日期键（本地时区 YYYY-MM-DD）→ 短日期展示（9月5日 / Sep 5）。 */
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${day}T00:00:00`))
}

/** 日期键 → 长日期展示（2026年9月5日 / September 5, 2026），tooltip 标题用。 */
export function formatDayLong(day: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(`${day}T00:00:00`))
}

/** 相对生成时间（列表场景刻意粗糙，同 archive-manager）。 */
export function formatRelative(timestamp: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const diffMs = timestamp - Date.now()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (Math.abs(diffMs) < hour) return rtf.format(Math.round(diffMs / minute), 'minute')
  if (Math.abs(diffMs) < day) return rtf.format(Math.round(diffMs / hour), 'hour')
  return rtf.format(Math.round(diffMs / day), 'day')
}
