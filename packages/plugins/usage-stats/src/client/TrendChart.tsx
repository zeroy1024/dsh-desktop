/**
 * 每日 Token 趋势折线图：按模型多序列（用量前 6 名），时间范围 7/30/90/全部。
 * SVG 自绘：Catmull-Rom 平滑折线；hover 显示纵向定位线 + x 轴落点圆点，
 * 详情浮层跟随鼠标（三段水平翻转 + 上/下弹，与热力图同一套定位规则），
 * 标题带当日全模型总量。线色为固定六色静态板（明暗主题均可读）。
 */
import { useMemo, useState } from 'react'
import type { SummaryDayRow, SummaryModelRow } from '../aggregator.ts'
import { bucketTotal } from '../aggregator.ts'
import { formatDay, formatTokensCompact } from './format.ts'
import type { Translate } from './types.ts'
import styles from './UsageStatsSection.module.css'

export type RangeKey = 7 | 30 | 90 | 0

const RANGE_OPTIONS: ReadonlyArray<{ key: RangeKey; labelKey: 'range7' | 'range30' | 'range90' | 'rangeAll' }> = [
  { key: 7, labelKey: 'range7' },
  { key: 30, labelKey: 'range30' },
  { key: 90, labelKey: 'range90' },
  { key: 0, labelKey: 'rangeAll' },
]

const MAX_SERIES = 6
const WIDTH = 720
const HEIGHT = 220
const PAD_X = 8
const PAD_TOP = 8
const PAD_BOTTOM = 22

/** 序列 i 的配色 class（折线 stroke 与图例点 background 共用同一组变量）。 */
function seriesClass(index: number): string {
  switch (index) {
    case 0: return styles.seriesC0
    case 1: return styles.seriesC1
    case 2: return styles.seriesC2
    case 3: return styles.seriesC3
    case 4: return styles.seriesC4
    default: return styles.seriesC5
  }
}

/** 图例/tooltip 里的序列名：model 为空时退化为 provider。 */
function seriesLabel(row: SummaryModelRow): string {
  return row.model === '' ? row.provider : row.model
}

/** hover 详情浮层：日期 + 当日总量 + 各非零序列数值（内容与配色同图例）。 */
function TrendTooltip(props: {
  day: string
  index: number
  totals: readonly number[]
  series: ReadonlyArray<{ model: SummaryModelRow; points: readonly number[] }>
}) {
  const { day, index, totals, series } = props
  return (
    <>
      <div className={styles.tooltipDay}>
        {formatDay(day)} · {formatTokensCompact(totals[index] ?? 0)}
      </div>
      {series.map(({ model, points }, seriesIndex) => {
        const value = points[index] ?? 0
        if (value === 0) return null
        return (
          <div key={`${model.provider}/${model.model}`} className={styles.tooltipRow}>
            <span className={`${styles.legendDot} ${seriesClass(seriesIndex)}`} />
            <span className={styles.tooltipName}>{seriesLabel(model)}</span>
            <span className={styles.tooltipValue}>{formatTokensCompact(value)}</span>
          </div>
        )
      })}
    </>
  )
}

export function TrendChart({ byDay, byModel, t }: {
  byDay: SummaryDayRow[]
  byModel: SummaryModelRow[]
  t: Translate
}) {
  const [range, setRange] = useState<RangeKey>(30)
  /** hover 状态：命中的日期下标 + 指针在图表容器内的百分比坐标（tooltip 跟随鼠标）。 */
  const [hover, setHover] = useState<{ index: number; xPct: number; yPct: number } | undefined>(undefined)

  const chart = useMemo(() => {
    const days = byDay.map(row => row.day)
    if (days.length === 0) return undefined
    const start = range > 0 ? Math.max(0, days.length - range) : 0
    const rangeRows = byDay.slice(start)
    if (rangeRows.length === 0) return undefined
    const rangeDays = rangeRows.map(row => row.day)
    const series = byModel.slice(0, MAX_SERIES).map(model => ({
      model,
      points: rangeDays.map(day => model.perDay[day] ?? 0),
    }))
    const peak = Math.max(1, ...series.flatMap(({ points }) => points))
    const totals = rangeRows.map(row => bucketTotal(row))
    const xTicks = rangeDays.length <= 1 ? [0] : [0, Math.floor((rangeDays.length - 1) / 2), rangeDays.length - 1]
    return { days: rangeDays, series, peak, totals, xTicks }
  }, [byDay, byModel, range])

  if (chart === undefined) {
    return (
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>{t('trendTitle')}</h3>
          <div className={styles.rangePills}>
            {RANGE_OPTIONS.map(option => (
              <button
                key={option.key}
                type="button"
                className={styles.rangePill}
                aria-pressed={option.key === range}
                onClick={() => setRange(option.key)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.emptySmall}>{t('noDataInRange')}</p>
      </section>
    )
  }

  const { days, series, peak, totals, xTicks } = chart
  const innerWidth = WIDTH - PAD_X * 2
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM
  const xAt = (index: number): number => PAD_X + (days.length <= 1 ? innerWidth / 2 : index / (days.length - 1) * innerWidth)
  const yAt = (value: number): number => PAD_TOP + (1 - value / peak) * innerHeight

  /**
   * Catmull-Rom → 三次贝塞尔平滑路径：控制点取相邻点的 1/6 张量。y 全程
   * clamp 在绘图区内，避免曲线在零值/峰值附近过冲画出界外。
   */
  const smoothPath = (points: readonly number[]): string => {
    const pts = points.map((value, index) => ({ x: xAt(index), y: yAt(value) }))
    if (pts.length < 3) {
      return pts.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    }
    const clampY = (y: number): number => Math.max(PAD_TOP, Math.min(HEIGHT - PAD_BOTTOM, y))
    let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`
    for (let index = 0; index < pts.length - 1; index++) {
      const p0 = pts[Math.max(0, index - 1)]!
      const p1 = pts[index]!
      const p2 = pts[index + 1]!
      const p3 = pts[Math.min(pts.length - 1, index + 2)]!
      const c1x = p1.x + (p2.x - p0.x) / 6
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6)
      const c2x = p2.x - (p3.x - p1.x) / 6
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6)
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
    }
    return d
  }

  const activeIndex = hover?.index
  const activeDay = activeIndex !== undefined ? days[activeIndex] : undefined
  // tooltip 跟随鼠标：水平三段翻转（左缘右开 / 中间居中 / 右缘左开），
  // 垂直按指针高度上弹或下弹，与每日活动热力图的浮层同一套规则。
  const tooltipTransform = hover === undefined ? undefined
    : hover.xPct <= 15
      ? 'translateX(8px)'
      : hover.xPct >= 82
        ? 'translateX(calc(-100% - 8px))'
        : 'translateX(-50%)'
  const tooltipShift = hover === undefined ? undefined
    : hover.yPct <= 45
      ? 'translateY(12px)'
      : 'translateY(calc(-100% - 12px))'
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{t('trendTitle')}</h3>
        <div className={styles.rangePills}>
          {RANGE_OPTIONS.map(option => (
            <button
              key={option.key}
              type="button"
              className={option.key === range ? styles.rangePillActive : styles.rangePill}
              aria-pressed={option.key === range}
              onClick={() => { setRange(option.key); setHover(undefined) }}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.legend}>
        {series.map(({ model }, index) => (
          <span key={`${model.provider}/${model.model}`} className={styles.legendItem}>
            <span className={`${styles.legendDot} ${seriesClass(index)}`} />
            {seriesLabel(model)}
          </span>
        ))}
      </div>

      <div className={styles.chartWrap}>
        <svg
          className={styles.trendSvg}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={t('trendTitle')}
          onMouseLeave={() => setHover(undefined)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const xPct = (event.clientX - rect.left) / rect.width * 100
            const yPct = (event.clientY - rect.top) / rect.height * 100
            const fraction = (event.clientX - rect.left) / rect.width
            const index = Math.round((fraction * WIDTH - PAD_X) / innerWidth * (days.length - 1))
            setHover({ index: Math.max(0, Math.min(days.length - 1, index)), xPct, yPct })
          }}
        >
          {/* 水平参考线：峰值/半峰 */}
          {[1, 0.5].map(fraction => (
            <line
              key={fraction}
              x1={PAD_X}
              x2={WIDTH - PAD_X}
              y1={yAt(peak * fraction)}
              y2={yAt(peak * fraction)}
              className={styles.trendGrid}
            />
          ))}
          {/* hover 纵向定位线 */}
          {activeIndex !== undefined && (
            <line
              x1={xAt(activeIndex)}
              x2={xAt(activeIndex)}
              y1={PAD_TOP}
              y2={HEIGHT - PAD_BOTTOM}
              className={styles.trendCursor}
            />
          )}
          {series.map(({ model, points }, seriesIndex) => (
            <path
              key={`${model.provider}/${model.model}`}
              d={smoothPath(points)}
              fill="none"
              className={`${styles.trendLine} ${seriesClass(seriesIndex)}`}
            />
          ))}
          {/* hover 日在 x 轴上的落点 */}
          {activeIndex !== undefined && (
            <circle
              cx={xAt(activeIndex)}
              cy={HEIGHT - PAD_BOTTOM}
              r={3.5}
              className={styles.trendDot}
            />
          )}
          {/* X 轴日期标尺（首/中/尾） */}
          {xTicks.map(tick => (
            <text
              key={tick}
              x={xAt(tick)}
              y={HEIGHT - 6}
              textAnchor={tick === 0 ? 'start' : tick === days.length - 1 ? 'end' : 'middle'}
              className={styles.trendAxis}
            >
              {formatDay(days[tick] ?? '')}
            </text>
          ))}
        </svg>

        {/* 详情浮层：跟随鼠标移动（三段翻转防出 card），与热力图同一套定位规则 */}
        {hover !== undefined && activeDay !== undefined && (
          <div
            className={styles.tooltip}
            style={{ left: `${hover.xPct.toFixed(2)}%`, top: `${hover.yPct.toFixed(2)}%`, transform: `${tooltipTransform} ${tooltipShift}` }}
          >
            <TrendTooltip day={activeDay} index={hover.index} totals={totals} series={series} />
          </div>
        )}
      </div>
    </section>
  )
}
