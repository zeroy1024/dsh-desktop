import { describe, expect, it } from 'vitest'
import { createAggregator, aggregateEntries, contentLineCount, diffsFromEntry } from '../src/client/aggregate.ts'
import type { HistoryEntryLite } from '../src/client/api.ts'

/** tool/call 事件构造（arguments 为模型原始 JSON 字符串）。 */
function call(seq: number, callId: string, name: string): HistoryEntryLite {
  return { event: { type: 'tool/call', seq, time: 1000, data: { turn: 1, step: 1, callId, name, arguments: '{}' } } }
}

/** tool/result 事件构造：meta 与可选的宿主视图。 */
function result(
  seq: number,
  callId: string,
  opts: { meta?: unknown; view?: unknown; error?: unknown } = {},
): HistoryEntryLite {
  return {
    event: {
      type: 'tool/result',
      seq,
      time: 2000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { callId } },
        ...(opts.error !== undefined ? { error: opts.error } : {}),
        ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
      },
    },
    ...(opts.view !== undefined ? { view: opts.view } : {}),
  }
}

/** DiffResultView 形状的宿主视图（for:'result' + card:'diff'）。 */
function diffView(diffs: unknown): unknown {
  return { for: 'result', view: { card: 'diff', diffs } }
}

describe('contentLineCount', () => {
  it('空文本 0 行、尾换行是终止符、内部空行保留', () => {
    expect(contentLineCount(null)).toBe(0)
    expect(contentLineCount('')).toBe(0)
    expect(contentLineCount('a\n')).toBe(1)
    expect(contentLineCount('a\nb')).toBe(2)
    expect(contentLineCount('a\n\nb\n')).toBe(3)
  })
})

describe('diffsFromEntry', () => {
  it('view（result 侧 diff 卡）优先', () => {
    const entry = result(2, 'c1', {
      meta: { diffs: [{ path: 'a.ts', oldText: 'old', newText: 'meta' }] },
      view: diffView([{ path: 'a.ts', oldText: null, newText: 'view' }]),
    })
    expect(diffsFromEntry(entry)).toEqual([{ path: 'a.ts', oldText: null, newText: 'view' }])
  })

  it('view 缺失/非 diff 卡时回落 meta.diffs；两者皆无返回 undefined', () => {
    expect(diffsFromEntry(result(2, 'c1', { meta: { diffs: [{ path: 'a.ts', oldText: 'o', newText: 'n' }] } })))
      .toEqual([{ path: 'a.ts', oldText: 'o', newText: 'n' }])
    expect(diffsFromEntry(result(2, 'c1', { view: { for: 'result', view: { card: 'read' } } }))).toBeUndefined()
    expect(diffsFromEntry(result(2, 'c1'))).toBeUndefined()
  })

  it('meta 空数组（新建/同内容覆写）返回 undefined，非 FileDiff 形状整体拒绝', () => {
    expect(diffsFromEntry(result(2, 'c1', { meta: { diffs: [] } }))).toBeUndefined()
    expect(diffsFromEntry(result(2, 'c1', { meta: { diffs: [{ path: 1 }] } }))).toBeUndefined()
  })
})

describe('createAggregator', () => {
  it('聚合 edit 的多 hunk 到同一文件并计数', () => {
    const aggregator = createAggregator()
    aggregator.apply(call(1, 'c1', 'edit'))
    aggregator.apply(result(2, 'c1', {
      meta: { diffs: [
        { path: 'src/a.ts', oldText: 'ctx\nfoo', newText: 'ctx\nFOO' },
        { path: 'src/a.ts', oldText: 'bar', newText: 'bar\nbaz' },
      ] },
    }))
    const { files, edits, appliedThroughSeq } = aggregator.result()
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('src/a.ts')
    expect(files[0]!.edits).toHaveLength(1)
    expect(files[0]!.edits[0]!.hunks).toHaveLength(2)
    expect(files[0]!.added).toBe(4)
    expect(files[0]!.removed).toBe(3)
    expect(edits).toHaveLength(1)
    expect(edits[0]!.tool).toBe('edit')
    expect(appliedThroughSeq).toBe(2)
  })

  it('新建文件走 view 的 args 兜底（oldText null）', () => {
    const aggregator = createAggregator()
    aggregator.apply(call(1, 'c1', 'write'))
    aggregator.apply(result(2, 'c1', {
      meta: { diffs: [] },
      view: diffView([{ path: 'new.ts', oldText: null, newText: 'line1\nline2\n' }]),
    }))
    const { files } = aggregator.result()
    expect(files[0]!.path).toBe('new.ts')
    expect(files[0]!.edits[0]!.tool).toBe('write')
    expect(files[0]!.added).toBe(2)
    expect(files[0]!.removed).toBe(0)
  })

  it('错误结果与非 diff 工具结果跳过，但水位照常推进', () => {
    const aggregator = createAggregator()
    aggregator.apply(call(1, 'c1', 'edit'))
    aggregator.apply(result(2, 'c1', { error: { name: 'E', code: 'x' }, meta: { diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] } }))
    aggregator.apply(result(3, 'c2', {}))
    aggregator.apply({ event: { type: 'user/message', seq: 4, time: 1, data: {} } })
    const { files, appliedThroughSeq } = aggregator.result()
    expect(files).toHaveLength(0)
    expect(appliedThroughSeq).toBe(4)
  })

  it('重复 seq 幂等（history 回拉与 live 帧的重叠窗口去重）', () => {
    const aggregator = createAggregator()
    aggregator.apply(call(1, 'c1', 'edit'))
    aggregator.apply(result(2, 'c1', { meta: { diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] } }))
    aggregator.apply(result(2, 'c1', { meta: { diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] } }))
    aggregator.apply(call(1, 'c1', 'edit'))
    expect(aggregator.result().edits).toHaveLength(1)
  })

  it('多文件多编辑：时间线按 seq 升序，文件按改动量降序', () => {
    const entries = [
      call(1, 'c1', 'edit'),
      result(2, 'c1', { meta: { diffs: [{ path: 'small.ts', oldText: 'a', newText: 'ab' }] } }),
      call(3, 'c2', 'write'),
      result(4, 'c2', { view: diffView([{ path: 'big.ts', oldText: null, newText: 'l1\nl2\nl3\nl4' }]) }),
      call(5, 'c3', 'edit'),
      result(6, 'c3', { meta: { diffs: [{ path: 'small.ts', oldText: 'ab', newText: 'abc' }] } }),
      result(7, 'unknown-call', { meta: { diffs: [{ path: 'mystery.ts', oldText: null, newText: 'x' }] } }),
    ]
    const { files } = aggregateEntries(entries)
    expect(files.map(f => f.path)).toEqual(['big.ts', 'small.ts', 'mystery.ts'])
    expect(files[1]!.edits).toHaveLength(2)
    expect(files[1]!.edits.map(e => e.seq)).toEqual([2, 6])
    expect(files[2]!.edits[0]!.tool).toBe('other')
  })

  it('同一改动量的文件按路径字典序稳定排序', () => {
    const entries = [
      call(1, 'c1', 'edit'),
      result(2, 'c1', { meta: { diffs: [{ path: 'b.ts', oldText: 'a', newText: 'b' }] } }),
      call(3, 'c2', 'edit'),
      result(4, 'c2', { meta: { diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] } }),
    ]
    expect(aggregateEntries(entries).files.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('结果级快照缓存：未新增编辑时两次 result 引用同一对象', () => {
    const aggregator = createAggregator()
    aggregator.apply(result(1, 'c1', { meta: { diffs: [{ path: 'a', oldText: 'x', newText: 'y' }] } }))
    const first = aggregator.result()
    aggregator.apply({ event: { type: 'tool/call', seq: 2, time: 1, data: { callId: 'c2', name: 'edit', arguments: '{}' } } })
    // tool/call 不改变文件投影（只登记配对表），快照仍复用。
    expect(aggregator.result()).toBe(first)
  })
})
