import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconCheckOutline16, IconCopyOutline16, JsonBlock, MessageText, Tooltip, writeClipboard,
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

/** 官方 contentParts 的触及子集：text 拼接、image 分离、其余块降级渲染。 */
function contentParts(content: readonly ContentBlock[]): {
  text: string
  images: readonly unknown[]
  rest: readonly ContentBlock[]
} {
  let text = ''
  const images: unknown[] = []
  const rest: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      text += (block as { text: string }).text
    } else if (block.type === 'image') {
      images.push(block)
    } else {
      rest.push(block)
    }
  }
  return { text, images, rest }
}

/**
 * 官方 projectUserText 的复刻：`/name`、`@name`、`@"quoted"` 词边界 token 装饰
 * 为引用 chip（会话引用优先），其余保持纯文本。logged 文本仍是唯一事实，这里
 * 仅呈现。与官方的差异：chip 不带 ReferenceIcon（该图标是 ui-conversation 内部
 * 组件，primitives 未导出），见 ADR-0007 差异清单。
 */
function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode {
  const ranges: { start: number; end: number; label: string; kind: 'session' | 'plain' }[] = []
  for (const rawLabel of [...new Set(sessionLabels)].toSorted((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  const re = /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0)
    const rawLabel = m[2] ?? ''
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(/[.,;:!?，。；：！？]+$/gu, '')
    if (label.length <= 1) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  ranges.sort((a, b) => a.start - b.start
    || (a.kind === b.kind ? b.end - a.end : a.kind === 'session' ? -1 : 1))
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = referenceKind === undefined
      ? label
      : referenceKind === 'session'
        ? label.slice(1)
        : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1)
    parts.push(
      <span
        key={tokenStart}
        className={styles.refChip}
        data-ref-chip={referenceKind ?? 'skill'}
        title={label}
      >
        {displayLabel}
      </span>,
    )
    cursor = end
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
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
 * primitives 组件同一份），动作行在官方「时间 · 复制」基础上于复制左侧
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
  const { text, images, rest } = contentParts(data.content)
  const referenceLabels = data.referenceLabels ?? []

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
        // 成功：收起确认并回填输入框（视图随 session/event 回推自动收缩）。
        setConfirming(false)
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
        {text !== '' && (
          <div className={styles.bubble}>
            {projectUserText(text, referenceLabels)}
            {rest.map((block, index) => (
              <JsonBlock
                key={index}
                label={t('extraBlock')}
                payload={block}
                truncatedLabel={total => t('jsonTruncated', { total })}
              />
            ))}
          </div>
        )}
        {referenceLabels.length > 0 && (
          <div className={styles.referenceSummary}>
            {t('referenceSummary', { labels: referenceLabels.join(t('referenceSeparator')) })}
          </div>
        )}
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
