/**
 * 本地结构化类型契约（desktop-frame 的 types.ts 先例）。
 *
 * 本插件消费的「缝」由 patches/0005-conversation-chat-group-seam.patch 引入
 * 上游 ui-chat（权威定义在 ui-chat/client 导出的 contract/slots）。
 * 按边界铁律不 import 上游 src；此文件只镜像插件消费的最小结构。
 *
 * - 运行时值导入（ui-primitives 的 DisclosureRow/图标）走 ui-primitives.d.ts
 *   的 ambient 声明——bundle 时它们是 external，由加载器模块表在浏览器里解析；
 * - 纯类型导入全部改指本文件；升级上游 pin 时若 slots.ts 的缝形状有变，
 *   tsc 不会自动发现漂移，需对照上述权威文件人工核对（补丁可退役的判据也
 *   记录在 patches.yml 的 0005 条目里）。
 */
import type { ReactNode } from 'react'

/* ===== 1. Chat 业务节点（镜像 ui-chat 的 chat-nodes 契约）===== */

/** Assistant 内容块：本插件只区分 text/image（断组信号）与 reasoning（可折叠）。 */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: unknown }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

/** 在途工具卡：tool/call 已见、tool/result 未落定（无 kind 判别字段）。 */
export interface RunningToolCall {
  callId: string
  name: string
  argsRaw: string
  turn: number
  step: number
  /** tool/call 事件落日志的 Unix 毫秒。 */
  time: number
  callView: unknown
  subCalls: readonly unknown[]
}

/** 已落定工具行：与在途调用经 callId 配对。 */
export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  time: number
  callId: string
  /** 窗口截断可能留下无 call 头的结果（卡片只显示 callId）。 */
  call: { name: string; argsRaw: string } | null
  callTime: number | null
  content: readonly unknown[]
  isError: boolean
  callView: unknown
  resultView: unknown
  subCalls: readonly unknown[]
}

/** 一次调用（运行中或已落定），递归拥有其子调用。 */
export type ToolCallBlock = RunningToolCall | ToolResultNode

/** 工具行负载：根生命周期携带全部递归子调用。 */
export interface ToolChatData {
  readonly root: ToolCallBlock
}

/** Assistant 行负载（流式与落定共用）。 */
export interface AssistantChatData {
  readonly status: 'running' | 'settled' | 'interrupted'
  readonly turn: number
  readonly step: number
  readonly blocks: readonly AssistantBlock[]
  readonly time: number
}

/** Chat 节点公共基座（ChatConversationViewNode）。 */
export interface ChatNodeBase {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: unknown
  readonly visibility: 'visible' | 'hidden'
}

/**
 * 本插件注册关注的 Chat 渲染种类。上游真实种类是 merge-extensible 的开放
 * 集合，未知种类在运行时表现为「既非过程行也非正文收尾」——折叠逻辑按
 * 不可折叠处理（这正是正确行为），类型面收窄为闭合并集只为让判别窄化可用。
 */
export interface ChatNodeDataMap {
  'tool-call': ToolChatData
  'assistant-step': AssistantChatData
  'user': { readonly seq: number }
}

export type ChatNodeKind = Extract<keyof ChatNodeDataMap, string>

export type ChatNode<Kind extends ChatNodeKind = ChatNodeKind> = {
  [RegisteredKind in Kind]: ChatNodeBase & {
    readonly kind: RegisteredKind
    readonly data: ChatNodeDataMap[RegisteredKind]
  }
}[Kind]

/* ===== 2. 会话流装配缝（镜像 slots.ts 中 0005 补丁引入的定义）===== */

/** 会话视图快照中本插件读取的切片（useSession 选择器的输入面）。 */
export interface ChatSessionSnapshot {
  running: boolean
}

export interface ChatSnapshot {
  order: readonly string[]
  nodes: ReadonlyMap<string, ChatNode | undefined>
}

/** 会话作用域快照选择器（槽位运行时座位注入的 useSession）。 */
export type UseSession = <T>(selector: (snapshot: ChatSessionSnapshot) => T) => T

/** 命名空间地址化翻译座位（本插件只读 conversation 命名空间的 group.* 键）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 会话流装配产物：一个业务节点独占一座，或一个折叠了连续过程节点
 * （纯思考 step、工具调用）的合成组。组 key 取组首成员的节点 key，
 * 滚动锚定与流身份无需新增身份机制即可表达。
 */
export type ChatFlowItem =
  | { readonly kind: 'node'; readonly key: string; readonly node: ChatNode }
  | { readonly kind: 'group'; readonly key: string; readonly nodes: readonly ChatNode[] }

/** Assistant 座位的块区间渲染变体（正文收尾 step 拆分渲染用）。 */
export type ChatNodeRenderVariant = 'prose-only' | 'reasoning-only'

/** 折叠组摘要行的 owner 货币（会话视图经 renderSlot 传入）。 */
export interface ChatFlowGroupOwnerProps {
  /** 折叠成员节点（anchorSeq 升序）。 */
  nodes: readonly ChatNode[]
  /**
   * 以与平铺完全一致的座位渲染一个成员（锚定 key、流包裹层、keyed 分发
   * 全部相同），展开后的组与平铺转录不可区分。可选变体拆分成员的块：
   * 正文收尾 step 的思考半段渲染在组内、正文半段在组外。
   */
  renderMember: (nodeKey: string, variant?: ChatNodeRenderVariant) => ReactNode
}

/** 注册座位的完整 props：owner 货币 + 运行时快照座位 + 翻译座位。 */
export type ActivityGroupRowProps = ChatFlowGroupOwnerProps & {
  useSession: UseSession
  useChat: <T>(selector: (snapshot: ChatSnapshot) => T) => T
  t: Translate
}

/* ===== 3. 客户端 Context（插件 apply 收到的服务面切片）===== */

export interface ClientContext {
  effect: (factory: () => (() => void) | void, name: string) => unknown
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void }
  /** 提供命名服务（chatFlowGrouping），供 ui-conversation 经 ctx.get 惰性读取。 */
  provide: (key: string, value: unknown) => void
  get: (key: string) => unknown
  slots: {
    inject: (name: string, factory: () => unknown) => unknown
    register: (
      opts: { name: string; locale?: string; id?: string; order?: number },
      component: unknown,
    ) => unknown
  }
}

declare global {
  interface Window {
    dshDesktop?: { platform?: string; dev?: boolean }
  }
}
