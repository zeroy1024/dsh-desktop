/**
 * 本地结构化类型契约（panel-shell / file-browser 的 types.ts 先例）。页面插件
 * 消费的缝是 @dsh-desktop/panel-shell 的 panelShell 服务 + panel-shell.page 槽；
 * 运行时经包依赖注入与 ctx 服务面拿到，类型面在此结构化镜像（铁律 4：不
 * import 上游 src，vendor tarball 不可作 devDep）。
 */
import type { PanelShellController, PanelPageMeta } from '@dsh-desktop/panel-shell/client'
import type { EnvelopeSource } from './api.ts'

export type { PanelShellController, PanelPageMeta }

/** 命名空间地址化翻译座位（locale 插件的 ctx.locale.bind 产物，{name} 单花括号插值）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 客户端 Context（页面插件 apply 收到的服务面切片）。 */
export interface ClientContext {
  effect: (fn: () => (() => void) | void, name: string) => void
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (
      opts: { name: string; locale?: string; id?: string; order?: number; inject?: () => unknown },
      component: unknown,
    ) => () => void
  }
  locale: {
    register: (ns: string, dicts: Record<string, Record<string, string>>) => void
    bind: (ns: string) => Translate
  }
  /** panel-shell 提供的元数据注册服务（运行半）。 */
  panelShell: PanelShellController
  /** 共享连接的解码信封观察缝（绝不自开第二条 mux 流）。 */
  connection: { api: EnvelopeSource }
}

/** 审查页完整 props：框架标准注入（sessionId/t）+ 容器 owner props（active）+ 注入面。 */
export interface ReviewPageProps {
  /** 框架按 session 作用域注入的当前会话 id。 */
  sessionId: string
  /** 容器按座位决定的激活态（切 tab 翻转，不卸载；非激活时应停昂贵订阅）。 */
  active: boolean
  /** 共享连接信封源（live 增量用）。 */
  envelopeSource: EnvelopeSource
  /** 命名空间翻译座位（经 locale 声明注入）。 */
  t: Translate
}
