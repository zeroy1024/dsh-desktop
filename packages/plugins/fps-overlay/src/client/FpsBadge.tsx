import { useEffect, useRef, useState } from 'react'
import {
  fpsFromDeltas,
  isJank,
  jankThresholdFromDeltas,
  pushSample,
  type Sample,
} from '../fps.ts'

const REFRESH_MS = 150
const JANK_FLASH_MS = 250

/**
 * 右上角实时 FPS。500ms 窗口平均，掉帧时闪红。
 * 只在 dshDesktop.dev 为 true 时挂载（preload 在 unpackaged 时注入 --dsh-dev）。
 */
export function FpsBadge() {
  const [label, setLabel] = useState('—')
  const [jank, setJank] = useState(false)
  const samples = useRef<Sample[]>([])
  const lastFrame = useRef(0)
  const lastPaint = useRef(0)
  const jankUntil = useRef(0)

  useEffect(() => {
    if (window.dshDesktop?.dev !== true) return
    let raf = 0
    const reset = (): void => {
      samples.current = []
      lastFrame.current = 0
      lastPaint.current = 0
      jankUntil.current = 0
      setLabel((current) => current === '—' ? current : '—')
      setJank((current) => current ? false : current)
    }
    const handleVisibility = (): void => reset()
    document.addEventListener('visibilitychange', handleVisibility)
    const tick = (now: number): void => {
      if (document.hidden) {
        raf = requestAnimationFrame(tick)
        return
      }
      if (lastFrame.current !== 0) {
        const dt = now - lastFrame.current
        pushSample(samples.current, now, dt)
        const deltas = samples.current.map((sample) => sample.dt)
        if (isJank(dt, jankThresholdFromDeltas(deltas))) {
          jankUntil.current = now + JANK_FLASH_MS
        }
      }
      lastFrame.current = now
      if (now - lastPaint.current >= REFRESH_MS) {
        lastPaint.current = now
        const fps = fpsFromDeltas(samples.current.map((sample) => sample.dt))
        const nextLabel = fps === null ? '—' : String(Math.round(fps))
        const nextJank = now < jankUntil.current
        setLabel((current) => current === nextLabel ? current : nextLabel)
        setJank((current) => current === nextJank ? current : nextJank)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  if (window.dshDesktop?.dev !== true) return null

  return (
    <div
      data-dsh-fps-overlay=""
      style={{
        position: 'absolute',
        top: 12,
        right: 16,
        zIndex: 30,
        padding: '4px 8px',
        borderRadius: 8,
        background: 'rgba(16, 18, 26, 0.78)',
        color: jank ? '#f87171' : '#4ade80',
        font: '12px/16px ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: 'none',
        userSelect: 'none',
        letterSpacing: '0.04em',
      }}
    >
      {label === '—' ? '—' : `${label} FPS`}
    </div>
  )
}
