/**
 * git unified diff 解析器（纯函数）：把 host 半 `git diff` 的原文解析成
 * 带行号的文件视图。会话模式的 FsDiffMeta 没有行号（见 aggregate.ts），
 * git 模式有完整的 @@ 头——精确行号锚定就从这里来。
 *
 * 解析纪律：宽容——无法辨认的行直接跳过（git 输出不可信包装），绝不让
 * 单个坏块炸掉整个解析；binary 文件（`Binary files ... differ` / `GIT
 * binary patch`）标记 binary、无行数据。
 */

/** 一个 hunk 的一行（kind 决定配色，old/new 行号随解析递增）。 */
export interface GitDiffRow {
  kind: 'context' | 'del' | 'add'
  text: string
  oldLine?: number
  newLine?: number
}

/** 一个 hunk：@@ -oldStart,oldLines +newStart,newLines @@ 与其行集。 */
export interface GitHunk {
  oldStart: number
  newStart: number
  rows: GitDiffRow[]
}

/** 一个文件的解析视图（git 侧路径为 worktree 相对路径）。 */
export interface GitFile {
  path: string
  oldPath?: string
  binary: boolean
  hunks: GitHunk[]
  added: number
  removed: number
}

/** 剥离 git 对含特殊字符路径的 C 引号包裹（"b/a b.txt"）。 */
function unquotePath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string
    } catch {
      return path.slice(1, -1)
    }
  }
  return path
}

function stripPrefix(line: string): string | undefined {
  const rest = line.slice(4)
  if (rest === '/dev/null') return undefined
  const path = rest.startsWith('a/') || rest.startsWith('b/') ? rest.slice(2) : rest
  return unquotePath(path)
}

/** @@ -oldStart[,oldLines] +newStart[,newLines] @@ */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/**
 * 解析 unified diff 原文为文件数组。
 * @param text - `git diff`（可拼接多文件）的原始输出。
 * @returns 文件视图数组（恒为数组；空输入返回空数组）。
 */
export function parseUnifiedDiff(text: string): GitFile[] {
  const files: GitFile[] = []
  let current: GitFile | undefined
  let hunk: GitHunk | undefined

  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      // 在 diff --git 行就建档（binary / rename 的后续行没有 ---/+++ 头）；
      // 路径启发式取最后一个 ' b/' 分段，quoted 路径剥引号。
      const spec = rawLine.slice('diff --git '.length)
      const bSplit = spec.lastIndexOf(' b/')
      const newGuess = bSplit >= 0 ? unquotePath(spec.slice(bSplit + 3)) : spec
      const oldGuess = bSplit >= 0 ? unquotePath(spec.slice(0, bSplit).replace(/^a\//u, '')) : undefined
      current = { path: newGuess, ...(oldGuess !== undefined ? { oldPath: oldGuess } : {}), binary: false, hunks: [], added: 0, removed: 0 }
      files.push(current)
      hunk = undefined
      continue
    }
    if (rawLine.startsWith('Binary files ') || rawLine === 'GIT binary patch') {
      if (current !== undefined) current.binary = true
      continue
    }
    if (rawLine.startsWith('--- ')) {
      // 旧路径；/dev/null = 新建文件（path 以 +++ 侧为准），不在此建档。
      continue
    }
    if (rawLine.startsWith('+++ ')) {
      const path = stripPrefix(rawLine)
      if (path !== undefined) {
        // diff --git 行已建档：+++ 侧（权威路径）只做覆盖，不重复建档。
        if (current === undefined) {
          current = { path, binary: false, hunks: [], added: 0, removed: 0 }
          files.push(current)
        } else {
          current.path = path
        }
      }
      continue
    }
    if (rawLine.startsWith('rename from ') && current !== undefined) {
      current.oldPath = rawLine.slice('rename from '.length)
      continue
    }
    if (rawLine.startsWith('@@ ')) {
      const match = HUNK_HEADER.exec(rawLine)
      if (match === null || current === undefined) continue
      hunk = {
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        rows: [],
      }
      current.hunks.push(hunk)
      continue
    }
    if (hunk === undefined || rawLine === '') continue
    const marker = rawLine[0] as string
    // 行内容为 '\' 转义（no-newline 标记）或未知前缀时跳过。
    if (marker === '-') {
      const row: GitDiffRow = { kind: 'del', text: rawLine.slice(1), oldLine: hunk.oldStart }
      hunk.oldStart += 1
      hunk.rows.push(row)
      if (current !== undefined) current.removed += 1
    } else if (marker === '+') {
      const row: GitDiffRow = { kind: 'add', text: rawLine.slice(1), newLine: hunk.newStart }
      hunk.newStart += 1
      hunk.rows.push(row)
      if (current !== undefined) current.added += 1
    } else if (marker === ' ') {
      const row: GitDiffRow = {
        kind: 'context',
        text: rawLine.slice(1),
        oldLine: hunk.oldStart,
        newLine: hunk.newStart,
      }
      hunk.oldStart += 1
      hunk.newStart += 1
      hunk.rows.push(row)
    }
  }
  return files
}
