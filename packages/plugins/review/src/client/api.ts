/** Durable journal data shapes and same-origin desktop Git routes. */

/** RPC/数据面错误的业务码。 */
export type ReviewApiErrorCode = 'network' | 'forbidden' | 'session-not-found' | 'internal'

export class ReviewApiError extends Error {
  constructor(readonly code: ReviewApiErrorCode) {
    super(`review-api: ${code}`)
    this.name = 'ReviewApiError'
  }
}

/** 每页请求的消息数（上游 runtime 的窗口页大小同款）。 */
export const HISTORY_PAGE_MESSAGES = 50

/** 全量回拉的页数上限（≈3000 条消息），超限保留最新页并置 truncated。 */
export const HISTORY_PAGE_LIMIT = 60

/** tool-fs 的 FileDiff 结构镜像（computeHunkDiffs 产物，无行号，hunk 旧/新两侧整块文本）。 */
export interface FileDiffLite {
  path: string
  /** 旧侧文本；null = 新建/覆写（旧侧不存在）。 */
  oldText: string | null
  /** 新侧文本。 */
  newText: string
}

/** 会话事件的用到切片（宽松信封：type/seq/time 严格，data 宽）。 */
export interface SessionEventLite {
  type: string
  seq: number
  time: number
  data?: unknown
}

/** session.history 的一行：原始事件 + 宿主现算的可选工具视图。 */
export interface HistoryEntryLite {
  event: SessionEventLite
  view?: unknown
}

export interface HistoryPageLite {
  events: HistoryEntryLite[]
  hasMore: boolean
  /** Raw page cursor; visible entries may all have been withdrawn. */
  nextBeforeSeq?: number
}

/** git status 的单文件条目（host 半 shared.ts 的 wire 镜像）。 */
export interface GitStatusEntryLite {
  x: string
  y: string
  path: string
  oldPath?: string
}

/** GET /dsh-desktop/review/git 的信封。 */
export type GitSnapshot =
  | { ok: true; git: false }
  | {
    ok: true
    git: true
    branch?: string
    status: GitStatusEntryLite[]
    diffText: string
    truncated: boolean
  }

/** 拉取工作区改动静照（uncommitted scope）。 */
export async function fetchGitSnapshot(sessionId: string): Promise<GitSnapshot> {
  let res: Response
  try {
    res = await fetch(`/dsh-desktop/review/git?sessionId=${encodeURIComponent(sessionId)}`)
  } catch {
    throw new ReviewApiError('network')
  }
  if (!res.ok) throw new ReviewApiError(res.status === 403 ? 'forbidden' : 'internal')
  try {
    return await res.json() as GitSnapshot
  } catch {
    throw new ReviewApiError('internal')
  }
}

/** 撤销单个文件的未提交修改（tracked = restore 自 HEAD；untracked = 删除）。 */
export async function restoreGitFile(sessionId: string, path: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('/dsh-desktop/review/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, path }),
    })
  } catch {
    throw new ReviewApiError('network')
  }
  if (!res.ok) throw new ReviewApiError(res.status === 403 ? 'forbidden' : 'internal')
}
