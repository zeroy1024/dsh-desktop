/**
 * 概览区：hero 卡（累计 Token + 四桶堆叠构成条与图例）+ 三张紧凑指标卡
 * （单日峰值 / 连续天数 / 会话数）。全部派生自 UsageSummary，无本地状态。
 */
import type { UsageSummary } from '../aggregator.ts'
import { formatDay, formatTokensCompact } from './format.ts'
import type { Translate } from './types.ts'
import styles from './UsageStatsSection.module.css'

export function OverviewCards({ summary, t }: { summary: UsageSummary; t: Translate }) {
  const { overall, byDay } = summary
  const totals = byDay.reduce(
    (acc, row) => {
      acc.uncachedInput += row.uncachedInput
      acc.cacheRead += row.cacheRead
      acc.cacheWrite += row.cacheWrite
      acc.output += row.output
      return acc
    },
    { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  )
  const totalTokens = totals.uncachedInput + totals.cacheRead + totals.cacheWrite + totals.output

  const buckets = [
    { labelKey: 'bucketUncachedInput', value: totals.uncachedInput, colorClass: styles.bucketC0 },
    { labelKey: 'bucketCacheRead', value: totals.cacheRead, colorClass: styles.bucketC1 },
    { labelKey: 'bucketCacheWrite', value: totals.cacheWrite, colorClass: styles.bucketC2 },
    { labelKey: 'bucketOutput', value: totals.output, colorClass: styles.bucketC3 },
  ]

  return (
    <div className={styles.overviewGrid}>
      <section className={styles.heroCard}>
        <span className={styles.heroLabel}>{t('cardTotal')}</span>
        <span className={styles.heroValue}>{formatTokensCompact(totalTokens)}</span>
        {/* 构成条为纯装饰：同信息由下方图例行文本承载 */}
        <div className={styles.heroBar} aria-hidden="true">
          {totalTokens > 0 && buckets.map(bucket => (
            bucket.value > 0 && (
              <span
                key={bucket.labelKey}
                className={`${styles.heroSeg} ${bucket.colorClass}`}
                style={{ width: `${(bucket.value / totalTokens * 100).toFixed(2)}%` }}
              />
            )
          ))}
        </div>
        <div className={styles.legend}>
          {buckets.map(bucket => (
            <span key={bucket.labelKey} className={styles.legendItem}>
              <span className={`${styles.legendDot} ${bucket.colorClass}`} />
              {t(bucket.labelKey)}
              <span className={styles.legendValue}>{formatTokensCompact(bucket.value)}</span>
            </span>
          ))}
        </div>
      </section>

      <section className={styles.statCard}>
        <span className={styles.statLabel}>{t('cardPeak')}</span>
        <span className={styles.statValue}>{formatTokensCompact(overall.peakTokens)}</span>
        <span className={styles.statCaption}>
          {overall.peakDay === undefined ? '—' : formatDay(overall.peakDay)}
        </span>
      </section>
      <section className={styles.statCard}>
        <span className={styles.statLabel}>{t('cardCurrentStreak')}</span>
        <span className={styles.statValue}>{overall.currentStreak}</span>
        <span className={styles.statCaption}>{t('cardLongestStreak')} {overall.longestStreak}</span>
      </section>
      <section className={styles.statCard}>
        <span className={styles.statLabel}>{t('cardSessions')}</span>
        <span className={styles.statValue}>{overall.sessions}</span>
        {overall.subagentSessions > 0 && (
          <span className={styles.statCaption}>{t('subagentSuffix', { count: overall.subagentSessions })}</span>
        )}
      </section>
    </div>
  )
}
