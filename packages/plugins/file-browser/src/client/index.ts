/**
 * file-browser 的 browser 半：把「文件」页注册进 panel-shell（两半注册一个
 * effect 的事务纪律，panel-page-stub 范本）。sessionMode:'required'——无
 * 当前会话时整个「文件」tab 不可见（根目录锚定会话工作区，用户拍板）。
 * order:20 排在轨迹页（10）之后、无 order 的诊断页之前。
 */
import { createElement } from 'react'
import { IconFolderClose16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from './types.ts'
import { FileBrowserPage } from './FileBrowserPage.tsx'
import {
  createFileOpenMailbox, toWorkspaceRelativePath, type FileBrowserOpenService,
} from './file-open.ts'
import { en, NS, zh } from './locales.ts'

/** Required services（loader 把本模块全部导出当对象插件交给 cordis fiber）。 */
export const inject = ['slots', 'locale', 'panelShell', 'layout', 'connection']

/**
 * 插件体：一个 apply，两半注册。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  const fileOpenMailbox = createFileOpenMailbox()
  const fileBrowserService: FileBrowserOpenService = {
    async tryOpen({ sessionId, cwd, path }) {
      if (cwd === undefined || ctx.panelShell.page('files') === undefined) return false
      const relPath = toWorkspaceRelativePath(path, cwd)
      if (relPath === undefined) return false
      fileOpenMailbox.enqueue({ sessionId, cwd, path, relPath })
      ctx.layout.openPanel()
      ctx.panelShell.openPage('files')
      return true
    },
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-browser: dictionaries')
  ctx.effect(() => {
    const dispose = ctx.reflect.provide('fileBrowser', fileBrowserService)
    return () => {
      fileOpenMailbox.drain()
      dispose()
    }
  }, 'file-browser: optional open service')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('panel-shell.page', () => {
    const disposeMeta = ctx.panelShell.registerPage({
      id: 'files',
      title: () => t('page.title'),
      icon: createElement(IconFolderClose16, { size: 14 }),
      order: 20,
      sessionMode: 'required',
    })
    const disposeSlot = ctx.slots.register({
      name: 'panel-shell.page',
      id: 'files',
      locale: NS,
      inject: () => ({ fileOpenMailbox, envelopeSource: ctx.connection.api }),
    }, FileBrowserPage)
    return () => {
      disposeSlot()
      disposeMeta()
    }
  })
}
