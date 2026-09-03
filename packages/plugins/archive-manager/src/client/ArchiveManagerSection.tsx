import { useEffect, useMemo, useState } from 'react'
import { TIMESTAMPS_PATH, UNARCHIVE_PATH } from '../shared.ts'
import styles from './ArchiveManagerSection.module.css'
import type {
  ArchiveManagerSectionProps, ArchiveTimestampMap, SessionId, SessionListState,
  SortDirection, SortField, WorkspaceListState,
} from './types.ts'

/**
 * 归档列表行：归档集合里的会话 + 会话元数据 + 工作区归属 + 归档时间的投影。
 * 元数据缺失（session store 未覆盖极老会话）时降级为 ID 缩略；归档时间缺失
 * （侧车未记录到的历史归档）时为 undefined，渲染侧省略该字段。
 */
interface ArchiveRow {
  id: SessionId
  title: string
  updatedAt: number | undefined
  archivedAt: number | undefined
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
  timestamps: ArchiveTimestampMap,
): ArchiveRow[] {
  return workspaces.archivedSessionIds.map((id) => {
    const row = sessions.byId[id]
    const workspace = workspaces.items.find(item => item.sessionIds.includes(id))
    return {
      id,
      title: row?.displayTitle ?? shortId(id),
      updatedAt: row?.updatedAt,
      archivedAt: timestamps[id],
      workspaceTitle: workspace?.title ?? '',
    }
  })
}

/** 排序比较：时间缺失的行恒排最后（无论升降序），组内顺序稳定。 */
function compareRows(field: SortField, direction: SortDirection) {
  return (a: ArchiveRow, b: ArchiveRow): number => {
    const left = a[field]
    const right = b[field]
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return direction === 'asc' ? left - right : right - left
  }
}

/** 分组视图的一节：一个工作区（或未分组）与其下的行。 */
interface ArchiveGroup {
  title: string
  rows: ArchiveRow[]
}

function groupRows(rows: readonly ArchiveRow[], noWorkspaceLabel: string): ArchiveGroup[] {
  const groups = new Map<string, ArchiveRow[]>()
  for (const row of rows) {
    const key = row.workspaceTitle !== '' ? row.workspaceTitle : noWorkspaceLabel
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }
  // 组按首行（即组内排序键最优行）的时间参与整体顺序，组内行序已排好。
  return [...groups.entries()].map(([title, bucket]) => ({ title, rows: bucket }))
}

/**
 * 「归档管理」设置页：读官方 workspaces/sessions store + 插件自记的归档时间
 * 侧车（POST 同源路由），写走 host 半挂在 webServer 上的 unarchive 路由。
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
  const [timestamps, setTimestamps] = useState<ArchiveTimestampMap>({})
  const [sortField, setSortField] = useState<SortField>('archivedAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [grouped, setGrouped] = useState(true)

  // 归档时间侧车：进页拉一次；归档集合大小变化（在侧边栏新归档/恢复）时重拉，
  // 让新行带上归档时间。路由失败时静默降级为不显示归档时间。
  const archivedCount = workspaces.archivedSessionIds.length
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const response = await fetch(TIMESTAMPS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (!response.ok) return
        const body = await response.json() as { ok?: boolean; timestamps?: ArchiveTimestampMap }
        if (!disposed && body.ok === true && body.timestamps !== undefined) setTimestamps(body.timestamps)
      } catch {
        // host 半未就绪（如插件 fiber 未激活）：省略归档时间列即可。
      }
    })()
    return () => { disposed = true }
  }, [archivedCount])

  const rows = useMemo(
    () => projectRows(workspaces, sessions, timestamps).sort(compareRows(sortField, sortDirection)),
    [workspaces, sessions, timestamps, sortField, sortDirection],
  )
  const groups = useMemo(
    () => groupRows(rows, t('noWorkspace')),
    [rows, t],
  )

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

  function renderRow(row: ArchiveRow) {
    const archivedText = formatRelative(row.archivedAt)
    const updatedText = formatRelative(row.updatedAt)
    return (
      <li key={row.id} className={styles.row}>
        <div className={styles.main}>
          <span className={styles.name}>{row.title}</span>
          <span className={styles.meta}>
            {[
              archivedText !== '' ? `${t('archivedAt')}: ${archivedText}` : '',
              updatedText !== '' ? `${t('lastActivity')}: ${updatedText}` : '',
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
    )
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.description}>{t('description')}</p>
      {unsupported && <p className={styles.notice} role="alert">{t('errorUnsupported')}</p>}
      {failedId !== undefined && (
        <p className={styles.error} role="alert">{t('errorRestore', { message: failureMessage })}</p>
      )}
      {rows.length > 0 && (
        <div className={styles.toolbar}>
          <label className={styles.control}>
            {t('sortBy')}
            <select
              className={styles.select}
              value={sortField}
              onChange={event => setSortField(event.target.value as SortField)}
            >
              <option value="archivedAt">{t('sortArchivedAt')}</option>
              <option value="updatedAt">{t('sortUpdatedAt')}</option>
            </select>
          </label>
          <button
            type="button"
            className={styles.controlBtn}
            onClick={() => setSortDirection(direction => direction === 'asc' ? 'desc' : 'asc')}
          >
            {sortDirection === 'asc' ? t('sortAsc') : t('sortDesc')}
          </button>
          <button
            type="button"
            className={styles.controlBtn}
            aria-pressed={grouped}
            onClick={() => setGrouped(value => !value)}
          >
            {grouped ? t('groupOn') : t('groupOff')}
          </button>
        </div>
      )}
      {rows.length === 0
        ? <p className={styles.empty}>{t('empty')}</p>
        : grouped
          ? (
              <div className={styles.groups}>
                {groups.map(group => (
                  <section key={group.title} className={styles.group}>
                    <h3 className={styles.groupTitle}>
                      {group.title}
                      <span className={styles.groupCount}>{group.rows.length}</span>
                    </h3>
                    <ul className={styles.list}>
                      {group.rows.map(renderRow)}
                    </ul>
                  </section>
                ))}
              </div>
            )
          : (
              <ul className={styles.list}>
                {rows.map(renderRow)}
              </ul>
            )}
    </div>
  )
}
