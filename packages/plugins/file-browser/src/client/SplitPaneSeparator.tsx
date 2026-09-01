/**
 * Accessible vertical split-pane separator. Pointer movement is rAF-coalesced
 * and previewed outside React; the owner commits one preference update when
 * the gesture ends.
 */
import {
  useCallback, useEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

interface DragState {
  pointerId: number
  startX: number
  startValue: number
  latestValue: number
  direction: 1 | -1
  frame: number | null
}

export interface SplitPaneSeparatorProps {
  className: string
  controls: string
  label: string
  value: number
  min: number
  max: number
  defaultValue: number
  step?: number
  readValue?: () => number
  /** Read a dynamic maximum without forcing an owner re-render per frame. */
  readMax?: () => number
  onPreview: (value: number) => number
  onCommit: (value: number) => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** One separator shared by mouse, touch/pen, and keyboard input. */
export function SplitPaneSeparator({
  className, controls, label, value, min, max, defaultValue, step = 16, readValue, readMax, onPreview, onCommit,
}: SplitPaneSeparatorProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const valueRef = useRef(value)
  const liveValue = readValue?.() ?? value
  const liveMax = readMax?.() ?? max
  valueRef.current = liveValue
  const [dragging, setDragging] = useState(false)

  const preview = useCallback((next: number): number => {
    const currentMax = readMax?.() ?? max
    const normalized = onPreview(clamp(next, min, currentMax))
    valueRef.current = normalized
    elementRef.current?.setAttribute('aria-valuenow', String(normalized))
    elementRef.current?.setAttribute('aria-valuemax', String(currentMax))
    return normalized
  }, [max, min, onPreview, readMax])

  const finish = useCallback((pointerId?: number): void => {
    const drag = dragRef.current
    if (drag === null || (pointerId !== undefined && drag.pointerId !== pointerId)) return
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame)
    const committed = preview(drag.latestValue)
    dragRef.current = null
    setDragging(false)
    onCommit(committed)
  }, [onCommit, preview])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1
    const currentValue = readValue?.() ?? valueRef.current
    valueRef.current = currentValue
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: currentValue,
      latestValue: currentValue,
      direction,
      frame: null,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }, [readValue])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    drag.latestValue = clamp(
      drag.startValue + (event.clientX - drag.startX) * drag.direction,
      min,
      readMax?.() ?? max,
    )
    if (drag.frame !== null) return
    drag.frame = window.requestAnimationFrame(() => {
      const current = dragRef.current
      if (current === null) return
      current.frame = null
      preview(current.latestValue)
    })
  }, [max, min, preview, readMax])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    const delta = (event.shiftKey ? step * 4 : step) * (rtl ? -1 : 1)
    const currentValue = readValue?.() ?? valueRef.current
    const currentMax = readMax?.() ?? max
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = currentValue - delta
    else if (event.key === 'ArrowRight') next = currentValue + delta
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = currentMax
    if (next === undefined) return
    event.preventDefault()
    onCommit(preview(next))
  }, [max, min, onCommit, preview, readMax, readValue, step])

  useEffect(() => () => {
    const drag = dragRef.current
    if (drag !== null && drag.frame !== null) window.cancelAnimationFrame(drag.frame)
    dragRef.current = null
  }, [])

  return (
    <div
      ref={elementRef}
      className={className}
      data-file-tree-splitter=""
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={liveMax}
      aria-valuenow={liveValue}
      tabIndex={0}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => { finish(event.pointerId) }}
      onPointerCancel={(event) => { finish(event.pointerId) }}
      onLostPointerCapture={(event) => { finish(event.pointerId) }}
      onDoubleClick={() => { onCommit(preview(defaultValue)) }}
      onKeyDown={onKeyDown}
    />
  )
}
