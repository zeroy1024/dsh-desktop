/**
 * 「用量统计」设置页：页面标题块（标题/简介/刷新 + 统计时间）+ 数据状态机
 * （loading/error/ready），ready 时按 概览 → 热力图 → 趋势折线 → 模型明细
 * 组装。取数走 node 半的同源 summary 路由；统计口径脚注在明细表内。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { fetchUsageSummary, isAbortError, UsageApiError, type SummaryResponse } from './api.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'
import { ModelTable } from './ModelTable.tsx'
import { OverviewCards } from './OverviewCards.tsx'
import { formatRelative } from './format.ts'
import { TrendChart } from './TrendChart.tsx'
import type { Translate, UsageStatsSectionProps } from './types.ts'
import styles from './UsageStatsSection.module.css'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: SummaryResponse }

function errorText(error: unknown, t: Translate): string {
  if (error instanceof UsageApiError) {
    if (error.kind === 'network') return t('errorNetwork')
    if (error.kind === 'forbidden') return t('errorForbidden')
    return t('errorInternal')
  }
  return t('errorInternal')
}

export function UsageStatsSection({ t }: UsageStatsSectionProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const data = await fetchUsageSummary(signal)
      setState({ kind: 'ready', data })
    } catch (error) {
      if (isAbortError(error)) return
      setState({ kind: 'error', message: errorText(error, t) })
    }
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const refresh = (): void => { void load(new AbortController().signal) }

  const renderHead = (meta?: string): ReactElement => (
    <div className={styles.pageHead}>
      <div>
        <h2 className={styles.pageTitle}>{t('title')}</h2>
        <p className={styles.pageIntro}>{t('description')}</p>
      </div>
      <div className={styles.headSide}>
        <button type="button" className={styles.refreshBtn} onClick={refresh}>
          {t('refresh')}
        </button>
        {meta !== undefined && <p className={styles.pageMeta}>{meta}</p>}
      </div>
    </div>
  )

  if (state.kind === 'loading') {
    return (
      <div className={styles.section}>
        {renderHead()}
        <p className={styles.hint}>{t('loading')}</p>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className={styles.section}>
        {renderHead()}
        <p className={styles.error}>{t('errorLoad', { message: state.message })}</p>
        <div>
          <button type="button" className={styles.refreshBtn} onClick={refresh}>
            {t('retry')}
          </button>
        </div>
      </div>
    )
  }

  const { summary, generatedAt, scanned, cached } = state.data
  if (summary.overall.sessions === 0) {
    return (
      <div className={styles.section}>
        {renderHead()}
        <p className={styles.empty}>{t('empty')}</p>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      {renderHead(t('generatedAt', { time: formatRelative(generatedAt), scanned, cached }))}
      <OverviewCards summary={summary} t={t} />
      <ActivityHeatmap byDay={summary.byDay} t={t} />
      <TrendChart byDay={summary.byDay} byModel={summary.byModel} t={t} />
      <ModelTable summary={summary} t={t} />
    </div>
  )
}
