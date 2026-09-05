/**
 * 本地结构化契约：只镜像本插件触碰的公开服务/槽位面，不 import upstream src。
 * 运行时数据仍由官方 client runtime 拥有；slot 渲染器注入 standard kit
 * （useSession/inputActions/sessionId/t 等），勿自行 import。
 */

import type { ReactNode } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IConversation, InputActions as NativeInputActions, UserMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RewindImageRuntime } from './restore-images.ts'

export type SessionId = string

/** 内容块的触及子集（text 块参与撤回回填，其余按官方语义走图片/降级）。 */
export type ContentBlock = UserMessageNode['content'][number]

/** chat 'user' 节点数据的触及子集（UserMessageNode 本地面）。 */
export interface UserNodeData {
  kind: 'user'
  seq: number
  time: number
  content: readonly ContentBlock[]
  /** 相邻召回节点关联的会话引用标签（官方同名可选字段）。 */
  referenceLabels?: readonly string[]
}

/** conversation.chat.node 的 owner props 触及子集。 */
export interface ChatNodeOwnerFace<TData> {
  node: { key: string; data: TData }
  renderMessageImages?: (input: { images: readonly unknown[]; align: 'end' }) => ReactNode
}

/** 官方 locale 翻译函数形态。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 输入框动作面（standard kit 注入）。 */
export type InputActions = Pick<NativeInputActions, 'setDraft' | 'addImages'>

/** 会话快照的触及子集。 */
export interface SessionSnapshotFace {
  running: boolean
}

export type SnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S) => S

/** shadow 用户消息渲染器的完整 props（owner + standard kit）。 */
export interface RewindUserMessageProps extends ChatNodeOwnerFace<UserNodeData> {
  sessionId: SessionId
  t: Translate
  inputActions: InputActions
  useSession: SnapshotSelectorHook<SessionSnapshotFace>
  imageRuntime?: RewindImageRuntime
}

export interface LocaleRuntime {
  register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => () => void
  bind: (namespace: string) => Translate
}

export interface SlotsRuntime {
  inject: (name: string, factory: () => unknown) => unknown
  register: (options: Record<string, unknown>, component: unknown) => () => void
}

export interface ClientContext {
  sessions: Pick<ISessions, 'binding'>
  conversation: Pick<IConversation, 'createDraftImages' | 'releaseDraftImages' | 'input'>
  sessionEventViews: {
    register(transform: (source: import('./event-visibility.ts').EventSource) => {
      source: import('./event-visibility.ts').EventSource
      dispose(): void
    }): () => void
  }
  effect: (factory: () => void | (() => void), name?: string) => unknown
  inject: (services: readonly string[], callback: (scope: Record<string, unknown>) => unknown) => unknown
  locale: LocaleRuntime
  slots: SlotsRuntime
}
