/**
 * 本地结构化类型契约（panel-shell 的 types.ts 先例）。页面插件消费的
 * 缝是 @dsh-desktop/panel-shell 的 `panelShell` 服务 + `panel-shell.page`
 * 槽；运行时经包依赖注入与 ctx 服务面拿到，类型面在此结构化镜像。
 */
import type { ReactNode } from 'react'
import type { PanelShellController, PanelPageMeta } from '@dsh-desktop/panel-shell/client'

export type { PanelShellController, PanelPageMeta }

/** 命名空间地址化翻译座位（locale 插件的 ctx.locale.bind 产物）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Stub 注入面：页面清单来源 + badge 演示写入器。 */
export interface PanelStubInjected {
  /** The container's registry (page metadata source). */
  registry: PanelShellController
  /** Move the demo badge count; negative deltas clamp at zero. */
  bumpBadge: (delta: number) => void
}

/** Stub 页完整 props：会话标准 prop + 注入面 + 翻译座位。 */
export interface PanelStubComponentProps {
  /** 框架按 session 作用域注入的当前会话 id。 */
  sessionId: string
  /** 容器按座位决定的激活态（切 tab 翻转，不卸载）。 */
  active: boolean
  registry: PanelShellController
  bumpBadge: (delta: number) => void
  t: Translate
}

export type PanelPageMetaIcon = ReactNode

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
}
