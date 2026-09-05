/** Rewind is a view over the append-only log; transport cursors always stay raw. */
import { REWIND_EVENT_TYPE, rewindRange, isRewound, type RewindRange } from '../shared.ts'

interface EventData { readonly seq: number; readonly type: string; readonly data?: unknown }
export type EventEntry =
  | { readonly type: 'event'; readonly event: EventData }
  | { readonly type: 'chunks'; readonly event: EventData }

export interface EventWindow<Entry extends EventEntry = EventEntry> {
  readonly entries: readonly Entry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change:
    | { readonly kind: 'replace' | 'prepend'; readonly entries: readonly Entry[] }
    | { readonly kind: 'append'; readonly entries: readonly Extract<Entry, { readonly type: 'event' }>[] }
}

export interface EventSource<Entry extends EventEntry = EventEntry> {
  getSnapshot(): EventWindow<Entry>
  subscribe(listener: () => void): () => void
}

function rangesIn(entries: readonly EventEntry[]): RewindRange[] {
  const ranges: RewindRange[] = []
  for (const entry of entries) {
    const range = rewindRange(entry.event)
    if (range !== undefined) ranges.push(range)
  }
  return ranges
}

function visible(entry: EventEntry, ranges: readonly RewindRange[]): boolean {
  if (entry.event.type === REWIND_EVENT_TYPE) return true
  return !isRewound(entry.event.seq, ranges)
}

/**
 * The usual no-rewind path returns the original snapshot and delta references.
 * Once a marker exists, only new deltas are inspected; a full visible window
 * is materialized lazily when a consumer actually asks for its entries.
 */
export function createRewindVisibilitySource<Entry extends EventEntry>(
  raw: EventSource<Entry>,
): { source: EventSource<Entry>; dispose(): void } {
  let ranges: readonly RewindRange[] = []
  const listeners = new Set<() => void>()
  let published: EventWindow<Entry>
  const project = (initial: boolean): void => {
    const window = raw.getSnapshot()
    const replace = initial || window.change.kind === 'replace'
    const added = rangesIn(replace ? window.entries : window.change.entries)
    ranges = replace ? added : added.length === 0 ? ranges : [...ranges, ...added]
    if (ranges.length === 0) {
      published = window
      return
    }
    const currentRanges = ranges
    let entries: readonly Entry[] | undefined
    const read = (): readonly Entry[] => entries ??= window.entries.filter(entry => visible(entry, currentRanges))
    published = {
      get entries() { return read() },
      hasMore: window.hasMore,
      revision: window.revision,
      change: replace || added.length > 0
        ? { kind: 'replace', get entries() { return read() } }
        : window.change.kind === 'append'
          ? { kind: 'append', entries: window.change.entries.filter(entry => visible(entry, currentRanges)) }
          : { kind: window.change.kind, entries: window.change.entries.filter(entry => visible(entry, currentRanges)) },
    }
  }
  project(true)
  const unsubscribe = raw.subscribe(() => {
    project(false)
    // A listener added during notification belongs to the next update.
    for (const listener of Array.from(listeners)) {
      try { listener() } catch (error) { console.error('[rewind] event view subscriber failed', error) }
    }
  })
  return {
    source: {
      getSnapshot: () => published,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    dispose() { unsubscribe(); listeners.clear() },
  }
}
