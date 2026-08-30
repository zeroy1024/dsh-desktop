/** 60Hz 下一帧约 16.7ms；超过两帧视为掉帧。 */
export const JANK_MS = (1000 / 60) * 2

/** 滑动窗口长度。 */
export const WINDOW_MS = 500
const MIN_REFRESH_SAMPLES = 8

export function fpsFromDeltas(deltas: readonly number[]): number | null {
  if (deltas.length === 0) return null
  let sum = 0
  for (const dt of deltas) sum += dt
  if (sum <= 0) return null
  return (1000 * deltas.length) / sum
}

export function isJank(dt: number, threshold = JANK_MS): boolean {
  return dt > threshold
}

/** 从近期帧间隔的中位数估算显示刷新周期，少量卡顿样本不会把基线拉高。 */
export function frameIntervalFromDeltas(deltas: readonly number[]): number | null {
  const usable = deltas.filter((dt) => Number.isFinite(dt) && dt > 0 && dt <= 100)
  if (usable.length < MIN_REFRESH_SAMPLES) return null
  usable.sort((left, right) => left - right)
  const middle = Math.floor(usable.length / 2)
  const median = usable.length % 2 === 0
    ? (usable[middle - 1]! + usable[middle]!) / 2
    : usable[middle]!
  return median
}

/** 以实际刷新率的两帧为卡顿线；样本不足时回落 60Hz 基线。 */
export function jankThresholdFromDeltas(deltas: readonly number[]): number {
  const interval = frameIntervalFromDeltas(deltas)
  return interval === null ? JANK_MS : interval * 2
}

export interface Sample {
  at: number
  dt: number
}

/** 追加一个样本并丢掉窗口外的旧点。 */
export function pushSample(samples: Sample[], at: number, dt: number, windowMs = WINDOW_MS): void {
  samples.push({ at, dt })
  const cutoff = at - windowMs
  while (samples.length > 0 && samples[0]!.at < cutoff) samples.shift()
}
