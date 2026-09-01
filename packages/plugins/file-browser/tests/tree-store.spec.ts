/**
 * 树模型纯函数测：展平（懒加载/展开/筛选/截断提示行）与状态更新器。
 * 组件交互（FileTree/FilePreview）无 jsdom 栈，由实机走查兜底——同
 * panel-shell 的测试取舍。
 */
import { describe, expect, it } from 'vitest'
import type { FsEntry } from '../src/client/api.ts'
import {
  applySelection, emptyTree, flattenTree, ancestorsOf, loadedPaths,
  withAncestorsExpanded, withDirState, withExpanded,
  type TreeRow, type TreeState,
} from '../src/client/tree-store.ts'

/** 测试用的文件行夹具。 */
function fileRow(key: string): TreeRow {
  return { key, name: key, kind: 'file', depth: 1, expanded: false }
}

const entry = (relPath: string, kind: 'dir' | 'file'): FsEntry => ({
  name: relPath.slice(relPath.lastIndexOf('/') + 1), relPath, kind,
})

/** 构一棵小目录表：root → {apps(dir), README.md(file)}；apps → {desktop(dir)}。 */
function seed(): TreeState {
  let state = withDirState(emptyTree, '', {
    status: 'ready',
    entries: [entry('apps', 'dir'), entry('README.md', 'file')],
  })
  state = withDirState(state, 'apps', { status: 'ready', entries: [entry('apps/desktop', 'dir')] })
  // 'apps/desktop' 未加载（懒加载现实）。
  return withExpanded(state, 'apps', true)
}

describe('flattenTree', () => {
  it('未筛选：根 + 已展开层的行，深度正确', () => {
    const rows = flattenTree(seed(), '')
    expect(rows.map(row => [row.key, row.depth])).toEqual([
      ['', 0], ['apps', 1], ['apps/desktop', 2], ['README.md', 1],
    ])
    expect(rows[2].status).toBe('idle') // apps/desktop 未加载：idle 而非 loading
  })

  it('根加载中只出根行', () => {
    const state = withDirState(emptyTree, '', { status: 'loading' })
    const rows = flattenTree(state, '')
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ key: '', status: 'loading' })
  })

  it('筛选：命中行保留；自身命中的未展开目录也保留', () => {
    const rows = flattenTree(seed(), 'readme')
    expect(rows.map(row => row.key)).toEqual(['', 'README.md'])
  })

  it('筛选：目录命中即保留该行（未命中后代不强求）', () => {
    const rows = flattenTree(seed(), 'apps')
    expect(rows.map(row => row.key)).toEqual(['', 'apps'])
  })

  it('筛选：无命中时只留根占位行', () => {
    const rows = flattenTree(seed(), 'zzz')
    expect(rows.map(row => row.key)).toEqual([''])
  })

  it('截断目录展开后子级末尾挂提示行', () => {
    let state = withDirState(emptyTree, '', {
      status: 'ready', entries: [entry('big', 'dir')],
    })
    state = withDirState(state, 'big', { status: 'ready', entries: [entry('big/x', 'file')], truncated: true })
    state = withExpanded(state, 'big', true)
    const rows = flattenTree(state, '')
    expect(rows.map(row => row.key)).toEqual(['', 'big', 'big/x', 'big\0trunc'])
    expect(rows[3].isTruncatedNote).toBe(true)
    expect(rows[3].depth).toBe(2)
  })
})

describe('状态更新器', () => {
  it('withExpanded 幂等开关', () => {
    const on = withExpanded(seed(), 'apps', true)
    expect(on.expanded.has('apps')).toBe(true)
    const off = withExpanded(on, 'apps', false)
    expect(off.expanded.has('apps')).toBe(false)
  })

  it('withDirState undefined 删除（回未加载态）', () => {
    const state = withDirState(seed(), 'apps', undefined)
    expect(state.dirs.has('apps')).toBe(false)
    expect(loadedPaths(state)).toEqual([''])
  })

  it('ancestorsOf 含根与自身；withAncestorsExpanded 展开全部祖先', () => {
    expect(ancestorsOf('apps/desktop/src')).toEqual(['apps/desktop', 'apps', ''])
    const state = withAncestorsExpanded(emptyTree, 'apps/desktop/src')
    expect([...state.expanded].toSorted()).toEqual(['apps', 'apps/desktop'])
  })
})

describe('applySelection（多选：单击/⌘切换/⇧范围）', () => {
  const rows = ['a', 'b', 'c', 'd'].map(fileRow)

  it('replace 单选并挪锚', () => {
    const r = applySelection(rows, new Set(['a']), 'a', 'c', 'replace')
    expect([...r.selection]).toEqual(['c'])
    expect(r.anchor).toBe('c')
  })

  it('toggle 加入/移除且不破坏他员', () => {
    const added = applySelection(rows, new Set(['a']), 'a', 'c', 'toggle')
    expect([...added.selection].toSorted()).toEqual(['a', 'c'])
    const removed = applySelection(rows, added.selection, added.anchor, 'c', 'toggle')
    expect([...removed.selection]).toEqual(['a'])
  })

  it('range 取锚到目标的闭区间（反向亦可），锚不挪', () => {
    const down = applySelection(rows, new Set(['a']), 'b', 'd', 'range')
    expect([...down.selection]).toEqual(['b', 'c', 'd'])
    expect(down.anchor).toBe('b')
    const up = applySelection(rows, new Set(), 'd', 'a', 'range')
    expect([...up.selection]).toEqual(['a', 'b', 'c', 'd'])
  })

  it('range 无锚/锚失效退化为单选', () => {
    const r = applySelection(rows, new Set(), null, 'b', 'range')
    expect([...r.selection]).toEqual(['b'])
    expect(r.anchor).toBe('b')
  })

  it('目标不在行序列（截断窗口外）：原样返回', () => {
    const r = applySelection(rows, new Set(['a']), 'a', 'ghost', 'toggle')
    expect([...r.selection]).toEqual(['a'])
    expect(r.anchor).toBe('a')
  })
})
