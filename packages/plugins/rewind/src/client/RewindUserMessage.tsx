import { useEffect, useRef, useState } from 'react'
import {
  IconCheckOutline16, IconCopyOutline16, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { REWIND_EXECUTE_PATH } from '../shared.ts'
import styles from './RewindUserMessage.module.css'
import type { ContentBlock, RewindUserMessageProps } from './types.ts'

/**
 * 撤回（undo）图标：左上折线箭头 + 右侧下弯弧线，Kimi Code 同款结构。
 * 上游 primitives 无 undo 图标，这里按官方 16×16 图标规格内联（currentColor，
 * 与 MessageIconActions 的视觉粗细一致）。
 */
function IconUndo16({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M6.2 10 2.8 6.6 6.2 3.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.8 6.6H10A3.8 3.8 0 0 1 10 14.2H7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** text 块 join；非文本块（json/附件元数据）不参与回填，保持官方 contentParts 语义近似。 */
function textOf(content: readonly ContentBlock[]): { text: string; images: readonly unknown[] } {
  let text = ''
  const images: unknown[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      text += (block as { text: string }).text
    } else if (block.type === 'image') {
      images.push(block)
    }
  }
  return { text, images }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 官方 formatMessageClock 的近似：今天 HH:MM，更早带短日期。 */
function formatClock(time: number): string {
  const d = new Date(time)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const now = new Date()
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return clock
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${clock}`
}

function errorMessage(t: RewindUserMessageProps['t'], status: number, code: string | undefined, message: string | undefined): string {
  if (code === 'not-live') return t('errorNotLive')
  if (code === 'compaction-boundary') return t('errorBoundary')
  if (code === 'invalid-at-seq') return t('errorInvalid')
  if (code === 'agent-running') return t('running')
  if (message !== undefined && message !== '') return t('errorGeneric', { message })
  return t('errorHttp', { status })
}

/** 复制按钮：官方 MessageIconActions 的 copied 交换逻辑（1s 对勾还原）。 */
function CopyAction({ text, t }: { text: string; t: RewindUserMessageProps['t'] }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  return (
    <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
      <button
        type="button"
        className={styles.action}
        aria-label={copied ? t('copied') : t('copy')}
        onClick={() => {
          if (copied) return
          void writeClipboard(text).then((ok) => {
            if (!ok) return
            setCopied(true)
            timer.current = setTimeout(() => {
              timer.current = null
              setCopied(false)
            }, 1000)
          })
        }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      </button>
    </Tooltip>
  )
}

/**
 * shadow 官方 key='user' 渲染器（priority 更低者胜出，官方为 fallback）：
 * 气泡与动作行镜像官方 MessageItem/MessageIconActions（主题 CSS 变量 +
 * primitives 图标同一份），动作行在官方「时间 · 复制」基础上于复制左侧
 * 增加「撤回编辑」；确认后原文回输入框并经同源路由追加墓碑——视图收缩
 * 由事件回推自动完成。
 */
export function RewindUserMessage(props: RewindUserMessageProps) {
  const { node, renderMessageImages, sessionId, t, inputActions, useSession } = props
  const running = useSession(snapshot => snapshot.running)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const data = node.data
  const { text, images } = textOf(data.content)

  async function execute(): Promise<void> {
    setPending(true)
    setError('')
    try {
      const response = await fetch(REWIND_EXECUTE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, atSeq: data.seq }),
      })
      const body = await response.json() as { ok?: boolean; code?: string; message?: string }
      if (response.ok && body.ok === true) {
        // 成功：先回填输入框（当前会话视图随 session/event 回推自动收缩）。
        inputActions.setDraft(text)
        return
      }
      // 出错即收起确认，让错误行（带重试）顶替同一槽位。
      setConfirming(false)
      setError(errorMessage(t, response.status, body.code, body.message))
    } catch (cause) {
      setConfirming(false)
      setError(t('errorGeneric', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={styles.userRow} data-time-hover-root>
      <div className={styles.userStack}>
        {renderMessageImages !== undefined && images.length > 0
          ? renderMessageImages({ images, align: 'end' })
          : null}
        {text !== '' && <div className={styles.bubble}>{text}</div>}
      </div>
      {/*
        确认 / 错误 / 常态动作行共用同一个 28px 行槽位（原位替换，不新增行），
        避免行高变化把整个会话列内容顶跳。确认文案过长时省略号截断，完整
        提示放 title；hint 语义由回填行为自解释。
      */}
      {confirming
        ? (
            <div className={styles.confirm} role="alertdialog" aria-label={t('confirmTitle')}>
              <span className={styles.confirmText} title={t('confirmHint')}>{t('confirmTitle')}</span>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={pending || running}
                onClick={() => { void execute() }}
              >
                {t('confirm')}
              </button>
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={() => { setConfirming(false); setError('') }}
              >
                {t('cancel')}
              </button>
            </div>
          )
        : error !== ''
          ? (
              <div className={styles.errorRow} role="alert">
                <span className={styles.errorText}>{error}</span>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => { setError(''); setConfirming(true) }}
                >
                  {t('retry')}
                </button>
              </div>
            )
          : (
            <div className={styles.actions}>
              <span className={styles.timeStart}>{formatClock(data.time)}</span>
              <Tooltip label={t('action')} side="bottom">
                <button
                  type="button"
                  className={styles.action}
                  aria-label={t('actionAria')}
                  data-unavailable={running || undefined}
                  onClick={() => { if (!running) setConfirming(true) }}
                >
                  <IconUndo16 />
                </button>
              </Tooltip>
              <CopyAction text={text} t={t} />
            </div>
          )}
    </div>
  )
}
