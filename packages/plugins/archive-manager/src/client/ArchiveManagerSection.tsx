import { useMemo, useState } from 'react'
import { UNARCHIVE_PATH } from '../shared.ts'
import styles from './ArchiveManagerSection.module.css'
import type {
  ArchiveManagerSectionProps, SessionId, SessionListState, WorkspaceListState,
} from './types.ts'

/**
 * 归档列表行：归档集合里的会话 + 会话元数据 + 工作区归属的投影。
 * 元数据缺失（session store 未覆盖极老会话）时降级为 ID 缩略。
 */
interface ArchiveRow {
  id: SessionId
  title: string
  updatedAt: number | undefined
  workspaceTitle: string
}

function shortId(id: SessionId): string {
  return id.startsWith('session-') ? id.slice('session-'.length, 'session-'.length + 8) + '…' : id
}

function formatRelative(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return ''
  // 跟随页面 locale；单档位阈值刻意粗糙，列表场景不需要精确时间。
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const diffMs = timestamp - Date.now()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (Math.abs(diffMs) < hour) return rtf.format(Math.round(diffMs / minute), 'minute')
  if (Math.abs(diffMs) < day) return rtf.format(Math.round(diffMs / hour), 'hour')
  if (Math.abs(diffMs) < 30 * day) return rtf.format(Math.round(diffMs / day), 'day')
  return rtf.format(Math.round(diffMs / (7 * day)), 'week')
}

function projectRows(
  workspaces: WorkspaceListState,
  sessions: SessionListState,
): ArchiveRow[] {
  return workspaces.archivedSessionIds.map((id) => {
    const row = sessions.byId[id]
    const workspace = workspaces.items.find(item => item.sessionIds.includes(id))
    return {
      id,
      title: row?.displayTitle ?? shortId(id),
      updatedAt: row?.updatedAt,
      workspaceTitle: workspace?.title ?? '',
    }
  })
}

/**
 * 「归档管理」设置页：读官方 workspaces/sessions store，写走同源 unarchive 路由。
 * 恢复成功后不手动改 store——host/archived-sessions-changed 回推会让行自然消失。
 */
export function ArchiveManagerSection(props: ArchiveManagerSectionProps) {
  const { t, useWorkspaces, useSessions } = props
  const workspaces = useWorkspaces(state => state)
  const sessions = useSessions(state => state)
  const [pendingId, setPendingId] = useState<SessionId | undefined>(undefined)
  const [failedId, setFailedId] = useState<SessionId | undefined>(undefined)
  const [failureMessage, setFailureMessage] = useState('')
  const [unsupported, setUnsupported] = useState(false)

  const rows = useMemo(() => projectRows(workspaces, sessions), [workspaces, sessions])

  async function restore(id: SessionId): Promise<void> {
    setPendingId(id)
    setFailedId(undefined)
    setFailureMessage('')
    try {
      const response = await fetch(UNARCHIVE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
      })
      if (response.status === 501) {
        setUnsupported(true)
        return
      }
      if (!response.ok) {
        setFailedId(id)
        setFailureMessage(`HTTP ${response.status}`)
        return
      }
      const body = await response.json() as { ok?: boolean }
      if (body.ok !== true) {
        setFailedId(id)
        setFailureMessage('unexpected response')
      }
      // 成功路径静默：事件回推后该行从列表消失即反馈。
    } catch (cause) {
      setFailedId(id)
      setFailureMessage(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setPendingId(undefined)
    }
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.description}>{t('description')}</p>
      {unsupported && <p className={styles.notice} role="alert">{t('errorUnsupported')}</p>}
      {failedId !== undefined && (
        <p className={styles.error} role="alert">{t('errorRestore', { message: failureMessage })}</p>
      )}
      {rows.length === 0
        ? <p className={styles.empty}>{t('empty')}</p>
        : (
            <ul className={styles.list}>
              {rows.map(row => (
                <li key={row.id} className={styles.row}>
                  <div className={styles.main}>
                    <span className={styles.name}>{row.title}</span>
                    <span className={styles.meta}>
                      {[
                        formatRelative(row.updatedAt),
                        row.workspaceTitle !== '' ? row.workspaceTitle : t('noWorkspace'),
                      ].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.restoreBtn}
                    disabled={pendingId !== undefined || unsupported}
                    aria-label={t('restoreAria', { name: row.title })}
                    onClick={() => { void restore(row.id) }}
                  >
                    {pendingId === row.id ? t('restoring') : t('restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}
