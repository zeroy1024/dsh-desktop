import { describe, expect, it } from 'vitest'
import { draftAnchorLabel, renderDraftLine, sameAnchor, serializeDrafts } from '../src/client/comments.ts'

const base = {
  path: 'src/auth.ts',
  editSeq: 12,
  hunkIndex: 0,
  side: 'new' as const,
  lineIndex: 3,
  lineText: 'const token = refresh()',
  comment: 'initial',
}

describe('sameAnchor', () => {
  it('五元组全等才同锚', () => {
    expect(sameAnchor({ ...base, comment: 'a' }, { ...base, comment: 'b' })).toBe(true)
    expect(sameAnchor(base, { ...base, lineIndex: 4 })).toBe(false)
    expect(sameAnchor(base, { ...base, side: 'old' })).toBe(false)
    expect(sameAnchor(base, { ...base, editSeq: 13 })).toBe(false)
  })
})

describe('renderDraftLine', () => {
  it('完整形态：路径（序数）·「引用行」 —— 意见', () => {
    expect(renderDraftLine({ path: 'src/auth.ts', ordinal: 2, lineText: 'const a = 1', comment: '加锁' }))
      .toBe('- src/auth.ts（第 2 次） ·「const a = 1」 —— 加锁')
  })

  it('单编辑省略序数；无引用行为文件级意见', () => {
    expect(renderDraftLine({ path: 'a.ts', lineText: 'x', comment: 'c' })).toBe('- a.ts ·「x」 —— c')
    expect(renderDraftLine({ path: 'a.ts', comment: '整体重构' })).toBe('- a.ts —— 整体重构')
    expect(renderDraftLine({ path: 'a.ts', lineText: '', comment: 'c' })).toBe('- a.ts —— c')
  })
})

describe('serializeDrafts', () => {
  it('表头 + 逐行；空列表返回 undefined', () => {
    expect(serializeDrafts([], '头')).toBeUndefined()
    expect(serializeDrafts([
      { path: 'a.ts', lineText: 'x', comment: 'c1' },
      { path: 'b.ts', ordinal: 1, comment: 'c2' },
    ], '请处理：')).toBe('请处理：\n- a.ts ·「x」 —— c1\n- b.ts（第 1 次） —— c2')
  })
})

describe('draftAnchorLabel', () => {
  it('长引用行截断加省略号', () => {
    const label = draftAnchorLabel({ ...base, lineText: 'x'.repeat(80) }, 10)
    expect(label).toBe('src/auth.ts ·「xxxxxxxxx…」')
  })
})
