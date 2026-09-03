/**
 * 数据面客户端：/api RPC 信封（裸 fetch，协议镜像上游 AbstractApiClient 的
 * wire 形状：POST /api/<method> + {type,rpcId,method,payload}，响应
 * {result:{ok:true,value}|{ok:false,error}}）与 mux 事件流的观察缝
 * （file-browser 的 api.ts 同款；不 import 上游包，铁律 4）。
 *
 * wire 契约的权威定义（pin dsh-v0.1.1-rc.2，升级时核对）：
 * - upstream/packages/host/apiproxy/src/api/rpc-map.ts（方法名注册表）
 * - upstream/packages/host/apiproxy/src/api/sessions.schema.ts（载荷/响应 zod）
 * - upstream/packages/host/apiproxy/src/api/events.ts（MuxFrame 联合）
 */

/** RPC/数据面错误的业务码。 */
export type ReviewApiErrorCode = 'network' | 'forbidden' | 'session-not-found' | 'internal'

export class ReviewApiError extends Error {
  constructor(readonly code: ReviewApiErrorCode) {
    super(`review-api: ${code}`)
    this.name = 'ReviewApiError'
  }
}

/**
 * 一元 RPC。失败（HTTP 层或信封 ok:false）统一抛 {@link ReviewApiError}；
 * 网关的未知方法/坏载荷等也落在此路。
 */
export async function rpc<T>(method: string, payload: unknown = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    })
  } catch {
    throw new ReviewApiError('network')
  }
  if (!res.ok) throw new ReviewApiError(res.status === 403 ? 'forbidden' : 'internal')
  interface Envelope { result?: { ok?: boolean; value?: T; error?: { code?: string } } }
  let full: Envelope
  try {
    full = await res.json() as Envelope
  } catch {
    throw new ReviewApiError('internal')
  }
  if (full.result?.ok !== true) {
    throw new ReviewApiError(normalizeCode(full.result?.error?.code))
  }
  return full.result.value as T
}

/** 上游 RpcError.code 收敛到本地码表：未列出的一律归 internal。 */
function normalizeCode(code: string | undefined): ReviewApiErrorCode {
  switch (code) {
    case 'session-not-found': return 'session-not-found'
    default: return 'internal'
  }
}

// ---------------------------------------------------------------------------
// session.history：分页回拉会话事件（页边界对齐 append 消息，事件页内 seq 升序）
// ---------------------------------------------------------------------------

/** 每页请求的消息数（上游 runtime 的窗口页大小同款）。 */
export const HISTORY_PAGE_MESSAGES = 50

/** 全量回拉的页数上限（≈3000 条消息），超限保留最新页并置 truncated。 */
export const HISTORY_PAGE_LIMIT = 60

/** tool-fs 的 FileDiff 结构镜像（computeHunkDiffs 产物，无行号，hunk 旧/新两侧整块文本）。 */
export interface FileDiffLite {
  path: string
  /** 旧侧文本；null = 新建/覆写（旧侧不存在）。 */
  oldText: string | null
  /** 新侧文本。 */
  newText: string
}

/** 会话事件的用到切片（宽松信封：type/seq/time 严格，data 宽）。 */
export interface SessionEventLite {
  type: string
  seq: number
  time: number
  data?: unknown
}

/** session.history 的一行：原始事件 + 宿主现算的可选工具视图。 */
export interface HistoryEntryLite {
  event: SessionEventLite
  view?: unknown
}

export interface HistoryPageLite {
  events: HistoryEntryLite[]
  hasMore: boolean
}

/**
 * 拉一页历史。`beforeSeq` 缺省 = 尾页（最新）；带前页首条 seq = 向前翻。
 */
export function fetchHistoryPage(sessionId: string, beforeSeq?: number): Promise<HistoryPageLite> {
  return rpc<HistoryPageLite>('session.history', {
    sessionId,
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    maxMessages: HISTORY_PAGE_MESSAGES,
  })
}

// ---------------------------------------------------------------------------
// session.prompt：把审查意见作为一条普通用户消息发进会话（回灌闭环）
// ---------------------------------------------------------------------------

/**
 * 以 queue 模式发送一条纯文本消息。clientTimeZone 与上游 runtime 行为对齐
 * （session.prompt 载荷的可选来源字段）。
 */
export function sendReviewMessage(sessionId: string, text: string): Promise<{ accepted: true }> {
  return rpc<{ accepted: true }>('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

// ---------------------------------------------------------------------------
// mux 帧观察（共享连接的解码信封；绝不自开第二条 /api/events.mux）
// ---------------------------------------------------------------------------

/**
 * 共享连接暴露的结构化信封观察缝（镜像上游 AbstractApiClient 的实例方法，
 * 不在 IApiClient 接口上——pin 升级核对点）。载体已按微任务批次分发解码帧。
 */
export interface EnvelopeMessage {
  type: string
  method?: string
  payload?: unknown
}

export interface EnvelopeSource {
  subscribeEnvelopes: (listener: (batch: readonly EnvelopeMessage[]) => void) => () => void
}

/** 目标会话的流信号：增量事件（含可选视图）或订阅基线（lastSeq）。 */
export type SessionSignal =
  | { kind: 'event'; event: SessionEventLite; view?: unknown }
  | { kind: 'subscribed'; lastSeq: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 宽容窄化 server-request 载荷为目标会话的 session/event / session/subscribed 帧。 */
function asSessionSignal(sessionId: string, payload: unknown): SessionSignal | undefined {
  if (!isRecord(payload) || payload.sessionId !== sessionId) return undefined
  if (payload.type === 'session/subscribed' && typeof payload.lastSeq === 'number') {
    return { kind: 'subscribed', lastSeq: payload.lastSeq }
  }
  if (payload.type === 'session/event' && isRecord(payload.event)
    && typeof payload.event.type === 'string' && typeof payload.event.seq === 'number') {
    const event = payload.event as unknown as SessionEventLite
    return { kind: 'event', event, ...(isRecord(payload.view) ? { view: payload.view } : {}) }
  }
  return undefined
}

/**
 * 观察共享连接信封批次，只转发目标会话的 session/event 与 session/subscribed。
 * 注意 wire 约定（fetch/handler.ts: SSE 信封的 method = mux 帧的 type），两种帧
 * 各走各的 method，都只按 payload.sessionId 过滤目标会话。返回源 disposer，
 * 订阅归属权留给调用方。
 */
export function openSessionSignals(
  source: EnvelopeSource,
  sessionId: string,
  onSignal: (signal: SessionSignal) => void,
): () => void {
  return source.subscribeEnvelopes((batch) => {
    for (const message of batch) {
      if (message.type !== 'server-request') continue
      if (message.method !== 'session/event' && message.method !== 'session/subscribed') continue
      const signal = asSessionSignal(sessionId, message.payload)
      if (signal !== undefined) onSignal(signal)
    }
  })
}
