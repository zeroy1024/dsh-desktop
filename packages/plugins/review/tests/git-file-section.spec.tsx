// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitFileSection } from '../src/client/GitFileSection.tsx'
import type { GitFile } from '../src/client/gitdiff.ts'
import type { Translate } from '../src/client/types.ts'

/** 关键 key 走 zh 词典，其余回退 key 本身（rewind 测试同款 stub）。 */
const t: Translate = (key, params) => {
  const dict: Record<string, string> = {
    'action.markReviewed': '标记已审',
    'action.copyDiff': '复制此文件 diff',
    'diff.expand': '… 其余 {n} 行',
    'diff.collapse': '收起',
    'diff.comment': '针对此行写审查意见',
    'diff.commentPlaceholder': '审查意见…',
    'diff.commentSubmit': '添加',
    'diff.commentCancel': '取消',
  }
  return (dict[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ''))
}

/** 40 行单 hunk（全 context 行）：>24 行默认折叠，head/tail 各 12 行同屏。 */
const bigFile: GitFile = {
  path: 'a.ts',
  binary: false,
  hunks: [{
    oldStart: 1,
    newStart: 1,
    rows: Array.from({ length: 40 }, (_, i) => ({
      kind: 'context' as const,
      text: `line ${i + 1}`,
      oldLine: i + 1,
      newLine: i + 1,
    })),
  }],
  added: 0,
  removed: 0,
}

function renderSection(onLineComment = vi.fn()) {
  const props = {
    file: bigFile,
    status: 'M',
    reviewed: false,
    expanded: true,
    draftsCount: 0,
    armedRevert: false,
    showRevert: false,
    t,
    onToggleExpanded: vi.fn(),
    onToggleReviewed: vi.fn(),
    onRevert: vi.fn(),
    onLineComment,
  }
  render(<GitFileSection {...props} />)
  return onLineComment
}

/** 对显示为 `text` 的行点「+」、输入评论并提交。 */
function commentOnRow(text: string, comment: string): void {
  const rowText = screen.getByText(text)
  const rowEl = rowText.parentElement as HTMLElement
  fireEvent.click(within(rowEl).getByRole('button', { name: '针对此行写审查意见' }))
  fireEvent.change(screen.getByPlaceholderText('审查意见…'), { target: { value: comment } })
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
}

afterEach(() => {
  cleanup()
})

describe('GitFileSection 折叠 hunk 的评论锚', () => {
  it('折叠态 tail 行评论带 hunk 内全局 rowIndex（28），展开后同一行锚一致', () => {
    const onLineComment = renderSection()

    // 折叠态：中段被裁掉（line 13 不渲染），tail 首行是全局第 28 行（40-12）。
    expect(screen.queryByText('line 13')).toBeNull()
    commentOnRow('line 29', '折叠态锚点')
    expect(onLineComment).toHaveBeenCalledWith(0, 28, 29, 'line 29', '折叠态锚点')

    // 展开后同一行（line 29）再评一次：rowIndex 不得漂移。
    fireEvent.click(screen.getByRole('button', { name: '… 其余 16 行' }))
    expect(screen.getByText('line 13')).toBeTruthy()
    commentOnRow('line 29', '展开态锚点')
    expect(onLineComment).toHaveBeenNthCalledWith(2, 0, 28, 29, 'line 29', '展开态锚点')
  })
})
