import { createElement } from 'react'
import type { SessionRowActionFactory } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { IconArchiveOutline20, IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ClientContext {
  effect(factory: () => (() => void) | void, name: string): void
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): (() => void) | void
    bind(namespace: string): (key: string) => string
  }
  sessionRowActions: { register(factory: SessionRowActionFactory): () => void }
}

const NS = 'dsh-desktop.session-actions'
export const inject = ['locale', 'sessionRowActions']

export function downloadSessionLog(sessionId: string): void {
  const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
  const anchor = document.createElement('a')
  anchor.href = `/api/session.export?${query}`
  anchor.download = `dsh-session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { export: '导出会话日志', archive: '归档会话' },
    en: { export: 'Export session log', archive: 'Archive session' },
  }), 'session-actions: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sessionRowActions.register(row => [
    {
      id: 'dsh-desktop.session-actions.export', label: t('export'),
      icon: createElement(IconDownloadOutline16), placement: 'menu',
      run: () => { downloadSessionLog(row.sessionId) },
    },
    {
      id: 'dsh-desktop.session-actions.archive', label: t('archive'),
      icon: createElement(IconArchiveOutline20, { size: 16 }), placement: 'inline',
      run: row.archive,
    },
  ]), 'session-actions: row contributions')
}
