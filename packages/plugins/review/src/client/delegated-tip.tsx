/**
 * 密集 diff 行上的提示：多颗「+」按钮共享一份 delay + 单例 fixed 气泡。
 * 宿主 Tooltip 只能 clone 单一锚点，无法按行重定位，所以这里自绘与宿主
 * 同 token 的气泡（delay 500ms / side=bottom）。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './ReviewPage.module.css'

const DELAY_MS = 500

export interface DelegatedTipBind {
  onMouseOver: (event: MouseEvent<HTMLElement>) => void
  onMouseOut: (event: MouseEvent<HTMLElement>) => void
}

/**
 * @param label - 气泡文案（通常是 t('diff.comment')）。
 * @param delayMs - 悬停延迟，默认与宿主 Tooltip chrome 一致；测试可传 0。
 * @returns bind 摊到每颗 `data-diff-tip` 按钮上；bubble 是最多一个 portal 节点。
 */
export function useDelegatedTip(label: string, delayMs = DELAY_MS): { bind: DelegatedTipBind; bubble: ReactNode } {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const current = useRef<HTMLElement | null>(null)

  const cancel = useCallback(() => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])

  const hide = useCallback(() => {
    cancel()
    current.current = null
    setPos(null)
  }, [cancel])

  const onMouseOver = useCallback((event: MouseEvent<HTMLElement>) => {
    const btn = event.currentTarget
    if (current.current === btn) return
    current.current = btn
    cancel()
    setPos(null)
    const place = (): void => {
      if (current.current !== btn) return
      const r = btn.getBoundingClientRect()
      setPos({ x: r.left + r.width / 2, y: r.bottom + 8 })
    }
    if (delayMs <= 0) {
      place()
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      place()
    }, delayMs)
  }, [cancel, delayMs])

  const onMouseOut = useCallback((event: MouseEvent<HTMLElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    hide()
  }, [hide])

  useEffect(() => {
    if (pos === null) return
    const onScrollOrResize = (): void => { hide() }
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [hide, pos])

  useEffect(() => cancel, [cancel])

  const bubble = pos === null || typeof document === 'undefined'
    ? null
    : createPortal(
      <span
        className={css.tipBubble}
        data-side="bottom"
        role="tooltip"
        style={{ left: pos.x, top: pos.y }}
      >
        {label}
      </span>,
      document.body,
    )

  return { bind: { onMouseOver, onMouseOut }, bubble }
}
