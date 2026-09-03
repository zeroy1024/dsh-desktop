import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/client/gitdiff.ts'

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' context line',
  '-removed line',
  '+added line 1',
  '+added line 2',
  ' context after',
  '\\ No newline at end of file',
  'diff --git a/bin.dat b/bin.dat',
  'index 333..444 100644',
  'Binary files a/bin.dat and b/bin.dat differ',
  'diff --git a/old.ts b/new.ts',
  'similarity index 90%',
  'rename from old.ts',
  'rename to new.ts',
  '--- a/old.ts',
  '+++ b/new.ts',
  '@@ -10 +10 @@',
  '-old value',
  '+new value',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('解析多文件：hunk 行号递增、± 计数正确', () => {
    const files = parseUnifiedDiff(SAMPLE)
    expect(files).toHaveLength(3)

    const [first] = files
    expect(first!.path).toBe('src/a.ts')
    expect(first!.hunks).toHaveLength(1)
    expect(first!.added).toBe(2)
    expect(first!.removed).toBe(1)

    const rows = first!.hunks[0]!.rows
    expect(rows[0]).toMatchObject({ kind: 'context', text: 'context line', oldLine: 1, newLine: 1 })
    expect(rows[1]).toMatchObject({ kind: 'del', text: 'removed line', oldLine: 2 })
    expect(rows[2]).toMatchObject({ kind: 'add', text: 'added line 1', newLine: 2 })
    expect(rows[3]).toMatchObject({ kind: 'add', text: 'added line 2', newLine: 3 })
    // 上下文行两侧行号都推进：新侧行 4（跳过被删的旧行 2 之后 old=3）
    expect(rows[4]).toMatchObject({ kind: 'context', text: 'context after', oldLine: 3, newLine: 4 })
    // no-newline 标记不产生行
    expect(rows).toHaveLength(5)
  })

  it('binary 文件标记 binary 且无行数据', () => {
    const files = parseUnifiedDiff(SAMPLE)
    const binary = files.find(file => file.path === 'bin.dat')
    expect(binary).toBeDefined()
    expect(binary!.binary).toBe(true)
    expect(binary!.hunks).toHaveLength(0)
  })

  it('重命名：path 取 +++ 侧，oldPath 来自 rename from', () => {
    const files = parseUnifiedDiff(SAMPLE)
    const renamed = files.find(file => file.path === 'new.ts')
    expect(renamed).toBeDefined()
    expect(renamed!.oldPath).toBe('old.ts')
    expect(renamed!.hunks[0]!.rows[0]).toMatchObject({ kind: 'del', oldLine: 10 })
    expect(renamed!.hunks[0]!.rows[1]).toMatchObject({ kind: 'add', newLine: 10 })
  })

  it('新建文件（--- /dev/null）解析为纯新增', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
    ].join('\n')
    const files = parseUnifiedDiff(text)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('new.txt')
    expect(files[0]!.added).toBe(2)
    expect(files[0]!.removed).toBe(0)
    expect(files[0]!.hunks[0]!.rows[0]!.newLine).toBe(1)
  })

  it('宽容：空输入返回空数组，畸形行跳过不抛错', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    const garbage = parseUnifiedDiff('not a diff at all\n@@ garbage\n+++ b/x\n@@ -1 +1 @@\n+ok')
    const last = garbage.at(-1)
    expect(last?.hunks[0]?.rows[0]?.text).toBe('ok')
  })
})
