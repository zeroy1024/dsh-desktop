/**
 * 本地结构化类型契约（panel-shell / stub 的 types.ts 先例）。页面插件消费的
 * 缝是 @dsh-desktop/panel-shell 的 panelShell 服务 + panel-shell.page 槽；
 * 运行时经包依赖注入与 ctx 服务面拿到，类型面在此结构化镜像。
 */
import type {
  PanelShellController, PanelPageMeta, PanelShellFocus,
} from '@dsh-desktop/panel-shell/client'
import type { FileSession, FileRemote } from './session-data.ts'
import type { EnvelopeSource } from './api.ts'
import type { FileOpenMailbox } from './file-open.ts'

export type { PanelShellController, PanelPageMeta, PanelShellFocus }

/** 命名空间地址化翻译座位（locale 插件的 ctx.locale.bind 产物）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 客户端 Context（页面插件 apply 收到的服务面切片）。 */
export interface ClientContext {
  effect: (fn: () => (() => void) | void, name: string) => void
  reflect: {
    provide: (key: string, value: unknown) => () => void
  }
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (
      opts: { name: string; locale?: string; id?: string; order?: number; inject?: (sessionId: string) => unknown },
      component: unknown,
    ) => () => void
  }
  locale: {
    register: (ns: string, dicts: Record<string, Record<string, string>>) => void
    bind: (ns: string) => Translate
  }
  /** panel-shell 提供的元数据注册服务（运行半）。 */
  panelShell: PanelShellController & PanelShellFocus
  /** ui-layout panel column action used by the external file-open service. */
  layout: { openPanel: () => void }
  /** Shared, already-decoded connection envelopes; file-browser never owns a second mux transport. */
  sessions: { binding(id: string): { session: FileSession } | undefined }
  remote: FileRemote
}

/** 页面组件完整 props：框架标准注入（sessionId/t）+ 容器 owner props。 */
export interface FilePageProps {
  /** 框架按 session 作用域注入的当前会话 id。 */
  sessionId: string
  /** 容器按座位决定的激活态（切 tab 翻转，不卸载）。 */
  active: boolean
  /** Cross-plugin file-open requests waiting for this session page. */
  fileOpenMailbox: FileOpenMailbox
  /** Shared connection envelope source used for session-scoped file activity refreshes. */
  envelopeSource: EnvelopeSource
  openPath: (path: string) => Promise<void>
  /** 命名空间翻译座位（经 locale 声明注入）。 */
  t: Translate
}
