/**
 * 每日活动热力图（GitHub contribution 风格）：列 = 周，行 = 周内 7 日——顶行
 * 周一（一周第一天）、底行周日。窗口固定 53 周，结束锚 = 本周日（最新列恒在
 * 最右）；未来日渲染空格子，保证最右列 7 格完整（今天是周一时本周列下方为
 * 空格而非缺格）。SVG 以 viewBox 等比缩放铺满面板（无横向滚动），月份标尺在
 * 底部；色深 = 当日四桶和的相对档位（brand 主色 color-mix 五档，跟随明暗主
 * 题）。hover 有数据的格子出受控浮层（长日期 + tokens + 会话数），顶行向下
 * 展开，移到空格或离开即消失。
 */
import { useMemo, useState } from 'react'
import type { SummaryDayRow } from '../aggregator.ts'
import { bucketTotal, localDateKey } from '../aggregator.ts'
import { formatDayLong, formatTokensCompact } from './format.ts'
import type { Translate } from './types.ts'
import styles from './UsageStatsSection.module.css'

const CELL = 9
const GAP = 3
const STEP = CELL + GAP
/** 底部月份标尺带高（viewBox 单位）。 */
const LABEL_BAND = 16

const MS_PER_DAY = 86_400_000
/** 固定一年窗口：最新列恒在最右（今天所在周），左侧无数据留空格。 */
const WEEKS = 53

/** 本地日历日的 UTC 锚点（只做天数代数，不受 DST 影响）。 */
function dayAnchor(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

/** UTC 锚点 → 本地日期键（与聚合层 localDateKey 同口径）。 */
function anchorToDay(anchor: number): string {
  // 用本地时区读出锚点当天的年月日（锚点取 UTC 午夜，本地可能差一天，
  // 因此先加 12h 余量再取本地日期，保证与日历日一一对应）。
  const date = new Date(anchor + 12 * 3_600_000)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 今天（本地日历日）所在周的周日锚点（顶行周一 → 底行周日）。 */
function currentWeekEndAnchor(): number {
  const todayAnchor = dayAnchor(localDateKey(Date.now()))
  return todayAnchor + (6 - (new Date(todayAnchor).getUTCDay() + 6) % 7) * MS_PER_DAY
}

interface GridCell {
  day: string
  column: number
  row: number
  total: number
  turns: number
  sessions: number
}

export function ActivityHeatmap({ byDay, t }: { byDay: SummaryDayRow[]; t: Translate }) {
  const [hover, setHover] = useState<GridCell | undefined>(undefined)

  const grid = useMemo(() => {
    if (byDay.length === 0) return undefined
    const days = new Map<string, { total: number; turns: number; sessions: number }>()
    for (const row of byDay) {
      days.set(row.day, { total: bucketTotal(row), turns: row.turns, sessions: row.sessions })
    }
    // 分位切档：token 用量跨日分布悬殊（峰值日可达其余日的百倍），线性比例
    // 会把绝大多数日子压在最浅档；按非零日的 25/50/75 分位切档区分度稳定。
    const nonZero = [...days.values()].filter(day => day.total > 0).map(day => day.total).toSorted((a, b) => a - b)
    const quantile = (fraction: number): number => {
      if (nonZero.length === 0) return 0
      const index = Math.min(nonZero.length - 1, Math.floor(fraction * nonZero.length))
      return nonZero[index]
    }
    const thresholds = nonZero.length >= 4
      ? [quantile(0.25), quantile(0.5), quantile(0.75)]
      : nonZero.map((_, index) => quantile((index + 1) / (nonZero.length + 1))).slice(0, 3)
    const endAnchor = currentWeekEndAnchor()
    // 起点必须是周一：column = floor(距起点天数/7) 隐含「每列从起点星期开始」，
    // 若起点取周日（与终点对齐），每个自然周会被从周日处切成两列——周日落进
    // 下一列底行、周六留在上一列（9月5日/6日 分列的根因）。起点取「52 周前的
    // 周一」（本周日 − 370 天），每列严格 = 周一→周日，共 53 列。
    const startAnchor = endAnchor - (WEEKS * 7 - 1) * MS_PER_DAY
    const cells: GridCell[] = []
    const monthLabels: Array<{ column: number; label: string }> = []
    let previousMonth = -1
    const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short' })
    // 未来日不跳过：本周列 7 格必须完整（今天是周一时下方 6 格为空格）。
    for (let anchor = startAnchor; anchor <= endAnchor; anchor += MS_PER_DAY) {
      const day = anchorToDay(anchor)
      const column = Math.floor((anchor - startAnchor) / MS_PER_DAY / 7)
      // 顶行 = 周一（一周第一天），底行 = 周日。
      const row = (new Date(anchor).getUTCDay() + 6) % 7
      const entry = days.get(day)
      cells.push({
        day, column, row,
        total: entry?.total ?? 0,
        turns: entry?.turns ?? 0,
        sessions: entry?.sessions ?? 0,
      })
      const date = new Date(anchor + 12 * 3_600_000)
      if (date.getMonth() !== previousMonth) {
        previousMonth = date.getMonth()
        monthLabels.push({ column, label: monthFormat.format(date) })
      }
    }
    return { cells, monthLabels, thresholds, weeks: WEEKS }
  }, [byDay])

  if (grid === undefined) return null
  const { cells, monthLabels, thresholds, weeks } = grid
  const viewBoxWidth = weeks * STEP
  const viewBoxHeight = 7 * STEP + LABEL_BAND

  // 色阶档位：0 → l0；其余按分位阈值切 l1-l4。
  const levelClass = (total: number): string => {
    if (total <= 0) return styles.heatL0
    if (total <= thresholds[0]) return styles.heatL1
    if (total <= thresholds[1]) return styles.heatL2
    if (total <= thresholds[2]) return styles.heatL3
    return styles.heatL4
  }

  // 浮层锚点用 viewBox 百分比（SVG 随容器缩放，像素定位会漂移）。
  const hoverX = hover === undefined ? '50%' : `${((hover.column * STEP + CELL / 2) / viewBoxWidth * 100).toFixed(2)}%`
  const hoverY = hover === undefined ? 0 : (hover.row * STEP + CELL / 2) / viewBoxHeight * 100
  // 垂直：顶两行向下展开（避让面板标题）；水平三段翻转防出 card——左缘
  // 右对齐、中间居中、右缘左对齐（translateX 百分比相对浮层自身宽度）。
  const hoverBelow = hover !== undefined && hover.row <= 1
  const hoverAlign = hover === undefined ? 'center'
    : hover.column <= Math.round(WEEKS * 0.15) ? 'start'
    : hover.column >= Math.round(WEEKS * 0.82) ? 'end'
    : 'center'
  const hoverTransform = hoverAlign === 'start'
    ? 'translateX(8px)'
    : hoverAlign === 'end'
      ? 'translateX(calc(-100% - 8px))'
      : 'translateX(-50%)'
  // 垂直以格子中心为锚：上弹 = 自身高度 + 半格间隙；下弹 = 半格 + 间隙。
  const verticalShift = hoverBelow
    ? 'translateY(12px)'
    : 'translateY(calc(-100% - 12px))'

  return (
    <section className={styles.panel}>
      <div className={styles.heatHead}>
        <h3 className={styles.panelTitle}>{t('heatmapTitle')}</h3>
        {/* 图例：少 → 四档色块 → 多（l0 空格不入图例；色块用 background 专属 class）。 */}
        <div className={styles.heatLegend}>
          {t('heatLegendLess')}
          {[styles.heatLegendL1, styles.heatLegendL2, styles.heatLegendL3, styles.heatLegendL4].map(className => (
            <span key={className} className={`${styles.heatLegendSwatch} ${className}`} />
          ))}
          {t('heatLegendMore')}
        </div>
      </div>
      <div className={styles.heatWrap} onMouseLeave={() => setHover(undefined)}>
        <svg
          className={styles.heatSvg}
          viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
          role="img"
          aria-label={t('heatmapTitle')}
        >
          {cells.map(cell => (
            <rect
              key={cell.day}
              x={cell.column * STEP}
              y={cell.row * STEP}
              width={CELL}
              height={CELL}
              rx={2}
              className={`${styles.heatCell} ${levelClass(cell.total)} ${hover?.day === cell.day ? styles.heatCellActive : ''}`}
              onMouseEnter={() => setHover(cell.total > 0 ? cell : undefined)}
            />
          ))}
          {monthLabels.map(({ column, label }) => (
            <text
              key={`${column}-${label}`}
              x={column * STEP}
              y={7 * STEP + 12}
              className={styles.heatMonth}
            >
              {label}
            </text>
          ))}
        </svg>
        {hover !== undefined && (
          <div
            className={styles.tooltip}
            style={{
              left: hoverX,
              top: `${hoverY}%`,
              transform: `${hoverTransform} ${verticalShift}`,
            }}
          >
            <div className={styles.tooltipDay}>{formatDayLong(hover.day)}</div>
            <div className={styles.tooltipSub}>
              {t('heatCellTip', { tokens: formatTokensCompact(hover.total), count: hover.sessions })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
