/**
 * 会话改动聚合器（纯函数）：把 session.history 回拉 / mux 增量到达的
 * HistoryEntry 流聚合成「按文件分组的编辑时间线」。
 *
 * 数据现实（pin dsh-v0.1.1-rc.2 的权威定义）：
 * - diff 的 durable 来源是 tool/result 事件的 `data.meta.diffs`（FsDiffMeta，
 *   tool-fs/src/diff.ts）：每 hunk 一条 FileDiff，只有旧/新两侧整块文本，
 *   **没有行号**（computeHunkDiffs 丢弃 structuredPatch 的行偏移）。
 * - 新建/同内容覆写在 meta 里是空 diffs；宿主现算的 view（DiffResultView，
 *   write.ts 的 presentResult args 兜底）带全文件 diff——所以 view 优先、
 *   meta 兜底（上游自述 "result side is authoritative"）。
 * - view 不持久化：只在 history 响应与 mux 帧上随事件下发。
 */
import type { FileDiffLite, HistoryEntryLite, SessionEventLite } from './api.ts'

/** 一次 write/edit 落盘的编辑事件（聚合的最小单元）。 */
export interface EditEvent {
  /** 结果事件的 seq（会话内单调，编辑时间线的排序键与评论锚点成分）。 */
  seq: number
  /** 事件时间（epoch 毫秒）。 */
  time: number
  /** 配对 tool/call 得到的工具名；配不上（旧会话/未知工具）给 'other'。 */
  tool: 'write' | 'edit' | 'other'
  /** 该次编辑的全部 hunk（同 path 多条 = 散落多处的替换）。 */
  hunks: FileDiffLite[]
  /** 新侧总行数（含上下文行；口径=DiffBlock 的 added 计数）。 */
  added: number
  /** 旧侧总行数。 */
  removed: number
}

/** 一个文件的审查视图：按发生顺序排列的编辑列表。 */
export interface FileReview {
  path: string
  edits: EditEvent[]
  added: number
  removed: number
}

/** 聚合结果（快照不可变，增量由 Aggregator 内部累积后重新产出）。 */
export interface ReviewAggregation {
  /** 按 added+removed 降序、次序 path 字典序。 */
  files: FileReview[]
  /** 全部编辑按 seq 升序（统计口径用）。 */
  edits: EditEvent[]
  /** 已聚合的最大事件 seq（任何类型；-1 = 空会话）。增量去重与 gap 检测的基准。 */
  appliedThroughSeq: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 防御窄化 FileDiff 数组（wire 不可信；无效条目丢弃，全无效返回 undefined）。 */
function narrowDiffs(value: unknown): FileDiffLite[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const diffs: FileDiffLite[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const { path, oldText, newText } = item
    if (typeof path !== 'string') return undefined
    if (typeof newText !== 'string') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    diffs.push({ path, oldText, newText })
  }
  return diffs
}

/** 从一条 history 记录提取 diff：view（result 侧 diff 卡）优先，meta.diffs 兜底。 */
export function diffsFromEntry(entry: HistoryEntryLite): FileDiffLite[] | undefined {
  const view = entry.view
  if (isRecord(view) && view.for === 'result' && isRecord(view.view) && view.view.card === 'diff') {
    const diffs = narrowDiffs(view.view.diffs)
    if (diffs !== undefined) return diffs
  }
  const data = entry.event.data
  if (isRecord(data) && isRecord(data.meta)) return narrowDiffs(data.meta.diffs)
  return undefined
}

/** DiffBlock 同款行终止符规则：空文本 0 行，单个尾换行是终止符不另起一行。 */
export function contentLineCount(text: string | null): number {
  if (text === null || text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

/** tool/result 事件 data 的用到切片。 */
interface ToolResultData {
  message?: { source?: { callId?: unknown } }
  error?: unknown
}

/** 从 tool/result 的 data 里取回配对 callId（message.source.callId）。 */
function callIdOf(event: SessionEventLite): string | undefined {
  const data = event.data
  if (!isRecord(data)) return undefined
  const callId = (data as ToolResultData).message?.source?.callId
  return typeof callId === 'string' ? callId : undefined
}

/**
 * 流式聚合器：按 seq 升序喂入 history 记录（或增量帧），随时产出快照。
 * 内部状态：callId → 工具名（只记 write/edit，配对 result 的 tool 标签）、
 * path → 编辑列表、已见最大 seq。重复 seq 静默跳过（history 回拉与 live 帧
 * 的重叠窗口天然去重）。
 */
export interface Aggregator {
  apply(entry: HistoryEntryLite): void
  result(): ReviewAggregation
}

export function createAggregator(): Aggregator {
  const calls = new Map<string, 'write' | 'edit'>()
  const files = new Map<string, FileReview>()
  const edits: EditEvent[] = []
  let appliedThroughSeq = -1
  let snapshot: ReviewAggregation | undefined

  return {
    apply(entry: HistoryEntryLite): void {
      const event = entry.event
      if (event.seq <= appliedThroughSeq) return
      appliedThroughSeq = event.seq

      if (event.type === 'tool/call') {
        const data = event.data
        if (!isRecord(data)) return
        const { callId, name } = data
        if (typeof callId !== 'string') return
        if (name === 'write' || name === 'edit') calls.set(callId, name)
        return
      }
      if (event.type !== 'tool/result') return

      const data = event.data
      if (isRecord(data) && data.error !== undefined) return
      const diffs = diffsFromEntry(entry)
      if (diffs === undefined) return

      const callId = callIdOf(event)
      const tool = (callId !== undefined ? calls.get(callId) : undefined) ?? 'other'
      const edit: EditEvent = {
        seq: event.seq,
        time: event.time,
        tool,
        hunks: diffs,
        added: diffs.reduce((sum, d) => sum + contentLineCount(d.newText), 0),
        removed: diffs.reduce((sum, d) => sum + contentLineCount(d.oldText), 0),
      }
      // 防御：一次结果理论上只动一个文件，但 hunks 按 path 分组写各自桶。
      const paths = new Set(diffs.map(d => d.path))
      for (const path of paths) {
        const hunks = diffs.filter(d => d.path === path)
        const file = files.get(path)
        const added = hunks.reduce((sum, d) => sum + contentLineCount(d.newText), 0)
        const removed = hunks.reduce((sum, d) => sum + contentLineCount(d.oldText), 0)
        if (file !== undefined) {
          file.edits.push({ ...edit, hunks, added, removed })
          file.added += added
          file.removed += removed
        } else {
          files.set(path, { path, edits: [{ ...edit, hunks, added, removed }], added, removed })
        }
      }
      edits.push(edit)
      snapshot = undefined
    },

    result(): ReviewAggregation {
      if (snapshot === undefined) {
        const list = [...files.values()]
        list.sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || (a.path < b.path ? -1 : 1))
        snapshot = { files: list, edits, appliedThroughSeq }
      }
      return snapshot
    },
  }
}

/**
 * 全量回拉聚合：把按 seq 升序排好的 history 记录一次聚合（分页收集后调用）。
 */
export function aggregateEntries(entries: readonly HistoryEntryLite[]): ReviewAggregation {
  const aggregator = createAggregator()
  for (const entry of entries) aggregator.apply(entry)
  return aggregator.result()
}
