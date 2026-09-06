/**
 * 模型明细表：每 (provider, model) 一行——四桶 + reasoning + 缓存命中率
 * （= cacheRead / 计费用量，上游 StatsLine 同款口径）+ 用量占比（带比例条）
 * + 请求数/会话数。列头点击排序；无法归因的用量单列一行置底。
 */
import { useMemo, useState } from 'react'
import type { UsageBuckets, UsageSummary } from '../aggregator.ts'
import { bucketTotal } from '../aggregator.ts'
import { formatPercent, formatTokensFull } from './format.ts'
import type { Translate } from './types.ts'
import styles from './UsageStatsSection.module.css'

/** 一行的展示投影（命中率/占比等派生值一次算好）。 */
interface ModelRowView {
  provider: string
  model: string
  buckets: UsageBuckets
  sessions: number
  total: number
  hitRate: number | undefined
  share: number
}

type SortKey = 'model' | 'total' | 'uncachedInput' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning' | 'hitRate' | 'share' | 'requests' | 'sessions'

const SORT_KEYS: readonly SortKey[] = [
  'model', 'total', 'uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'hitRate', 'share', 'requests', 'sessions',
]

function headerLabel(key: SortKey, t: Translate): string {
  switch (key) {
    case 'model': return t('tableModel')
    case 'total': return t('cardTotal')
    case 'uncachedInput': return t('bucketUncachedInput')
    case 'cacheRead': return t('bucketCacheRead')
    case 'cacheWrite': return t('bucketCacheWrite')
    case 'output': return t('bucketOutput')
    case 'reasoning': return t('bucketReasoning')
    case 'hitRate': return t('tableHitRate')
    case 'share': return t('tableShare')
    case 'requests': return t('tableRequests')
    case 'sessions': return t('tableSessions')
  }
}

/** 行排序：数值列 undefined（无命中率）视作 -1 恒排末尾。 */
function sortValue(row: ModelRowView, key: SortKey): number | string {
  switch (key) {
    case 'model': return `${row.provider}/${row.model}`
    case 'total': return row.total
    case 'sessions': return row.sessions
    case 'hitRate': return row.hitRate ?? -1
    case 'share': return row.share
    default: return row.buckets[key]
  }
}

export function ModelTable({ summary, t }: { summary: UsageSummary; t: Translate }) {
  const { rows, grandTotal } = useMemo(() => {
    const total
      = summary.byModel.reduce((sum, row) => sum + bucketTotal(row.buckets), 0)
        + bucketTotal(summary.unattributed)
    const projected = summary.byModel.map((row) => {
      const rowTotal = bucketTotal(row.buckets)
      const billedInput = row.buckets.uncachedInput + row.buckets.cacheRead + row.buckets.cacheWrite
      return {
        provider: row.provider,
        model: row.model,
        buckets: row.buckets,
        sessions: row.sessions,
        total: rowTotal,
        hitRate: billedInput > 0 ? row.buckets.cacheRead / billedInput : undefined,
        share: total > 0 ? rowTotal / total : 0,
      }
    })
    return { rows: projected, grandTotal: total }
  }, [summary])

  const [sortKey, setSortKey] = useState<SortKey>('total')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const sign = direction === 'asc' ? 1 : -1
    return rows.toSorted((a, b) => {
      const left = sortValue(a, sortKey)
      const right = sortValue(b, sortKey)
      if (typeof left === 'string' || typeof right === 'string') {
        return sign * String(left).localeCompare(String(right))
      }
      return sign * (left - right)
    })
  }, [rows, sortKey, direction])

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) setDirection(current => current === 'asc' ? 'desc' : 'asc')
    else {
      setSortKey(key)
      setDirection(key === 'model' ? 'asc' : 'desc')
    }
  }

  const unattributedTotal = bucketTotal(summary.unattributed)
  const hasUnattributed = unattributedTotal > 0 || summary.unattributed.requests > 0

  return (
    <section className={styles.panel}>
      <h3 className={styles.panelTitle}>{t('tableTitle')}</h3>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {SORT_KEYS.map((key) => {
                const active = key === sortKey
                return (
                  <th key={key} className={active ? styles.thActive : styles.th}>
                    <button
                      type="button"
                      className={styles.thBtn}
                      onClick={() => toggleSort(key)}
                      title={active ? t(direction === 'asc' ? 'sortAsc' : 'sortDesc') : undefined}
                    >
                      {headerLabel(key, t)}
                      {active && <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span>}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <tr key={`${row.provider}/${row.model}`} className={styles.tr}>
                <td className={styles.tdModel}>
                  <span className={styles.modelName}>{row.model === '' ? row.provider : row.model}</span>
                  <span className={styles.modelProvider}>{row.provider}</span>
                </td>
                <td className={styles.tdNum}>{formatTokensFull(row.total)}</td>
                <td className={styles.tdNum}>{formatTokensFull(row.buckets.uncachedInput)}</td>
                <td className={styles.tdNum}>{formatTokensFull(row.buckets.cacheRead)}</td>
                <td className={styles.tdNum}>{formatTokensFull(row.buckets.cacheWrite)}</td>
                <td className={styles.tdNum}>{formatTokensFull(row.buckets.output)}</td>
                <td className={styles.tdNumDim}>{formatTokensFull(row.buckets.reasoning)}</td>
                <td className={styles.tdNum}>{formatPercent(row.hitRate)}</td>
                <td className={styles.tdNum}>{formatPercent(row.share)}</td>
                <td className={styles.tdNum}>{row.buckets.requests}</td>
                <td className={styles.tdNum}>{row.sessions}</td>
              </tr>
            ))}
            {hasUnattributed && (
              <tr className={styles.tr} title={t('unattributedHint')}>
                <td className={styles.tdModel}>
                  <span className={styles.modelNameDim}>{t('unattributed')}</span>
                </td>
                <td className={styles.tdNum}>{formatTokensFull(unattributedTotal)}</td>
                <td className={styles.tdNum}>{formatTokensFull(summary.unattributed.uncachedInput)}</td>
                <td className={styles.tdNum}>{formatTokensFull(summary.unattributed.cacheRead)}</td>
                <td className={styles.tdNum}>{formatTokensFull(summary.unattributed.cacheWrite)}</td>
                <td className={styles.tdNum}>{formatTokensFull(summary.unattributed.output)}</td>
                <td className={styles.tdNumDim}>{formatTokensFull(summary.unattributed.reasoning)}</td>
                <td className={styles.tdNum}>—</td>
                <td className={styles.tdNum}>
                  {formatPercent(grandTotal > 0 ? unattributedTotal / grandTotal : undefined)}
                </td>
                <td className={styles.tdNum}>{summary.unattributed.requests}</td>
                <td className={styles.tdNum}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className={styles.footnote}>
        {t('footnoteBilling')} {t('footnoteCacheWrite')} {t('footnoteReasoning')} {t('footnoteRequests')}
      </p>
    </section>
  )
}
