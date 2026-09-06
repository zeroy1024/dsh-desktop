/**
 * 本地结构化契约：只镜像本插件触碰的公开服务/槽位面，不 import upstream src。
 * 运行时数据仍由官方 client runtime 拥有。
 */

/** 官方 locale 翻译函数形态（{name} 占位由实现替换）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** slots.register 针对 'settings.section'（list 槽）的触及 options 子集。 */
export interface SectionRegisterOptions {
  name: 'settings.section'
  id: string
  order?: number
  label: string | (() => string)
  locale?: string
}

/** slots.register 的宽松返回：卸载 disposer。 */
type Register = (
  options: SectionRegisterOptions | { name: 'settings.section.icon'; key: string },
  component: unknown,
) => () => void

export interface SlotsRuntime {
  /** 等目标槽声明存在后执行工厂；声明塌缩时自动回收。 */
  inject: (name: string, factory: () => unknown) => unknown
  register: Register
}

export interface LocaleRuntime {
  register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => () => void
  bind: (namespace: string) => Translate
}

export interface ClientContext {
  effect: (factory: () => void | (() => void), name?: string) => unknown
  locale: LocaleRuntime
  slots: SlotsRuntime
}

/** section 组件 props：owner 面（close）+ locale 合成的 t。 */
export interface UsageStatsSectionProps {
  close: () => void
  t: Translate
}
