/**
 * 双半共享常量。事件类型字面量与 patches/0012（dsh-session 声明）
 * 保持一致，客户端可见性和轮次投影均由本插件负责；刻意本地字面量，不 import
 * 上游构建产物，避免解析时序耦合。
 */
export const REWIND_EVENT_TYPE = 'dsh-desktop/session-rewind'

/** host 半挂进 webServer 的恢复路由（client 同源 fetch 同一路径）。 */
export const REWIND_EXECUTE_PATH = '/dsh-desktop/rewind/execute'

export interface RewindRange { readonly start: number; readonly end: number }

export function rewindRange(event: { readonly seq: number; readonly type: string; readonly data?: unknown }): RewindRange | undefined {
  if (event.type !== REWIND_EVENT_TYPE) return undefined
  const start = (event.data as { atSeq?: unknown } | undefined)?.atSeq
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > event.seq) return undefined
  return { start, end: event.seq }
}

/** Every marker remains effective, including a marker hidden by a later rewind. */
export function rewindRanges(events: readonly { readonly seq: number; readonly type: string; readonly data?: unknown }[]): RewindRange[] {
  return events.flatMap(event => {
    const range = rewindRange(event)
    return range === undefined ? [] : [range]
  })
}

export function isRewound(seq: number, ranges: readonly RewindRange[]): boolean {
  return ranges.some(range => seq >= range.start && seq < range.end)
}
