/** Same-origin desktop file routes and the local file-activity observation face. */

/** RPC/数据面错误的业务码（含 /fs 信封与 /api error.code 的并集子集）。 */
export type FsErrorCode =
  | 'session-not-found' | 'not-found' | 'bad-path' | 'forbidden'
  | 'symlink-escape' | 'is-directory' | 'denied' | 'unreadable' | 'network' | 'internal'

export class FsApiError extends Error {
  constructor(readonly code: FsErrorCode) {
    super(`fs-api: ${code}`)
    this.name = 'FsApiError'
  }
}

/** /fs list 的条目投影（镜像 node 半 FsEntry）。 */
export interface FsEntry {
  name: string
  /** 相对会话 root 的 POSIX 路径。 */
  relPath: string
  kind: 'dir' | 'file'
  size?: number
}

export interface FsListing {
  /** 服务端解析的会话根（canonical 绝对路径），openPath 拼绝对路径用。 */
  root: string
  entries: FsEntry[]
  truncated: boolean
}

export type FsFileContent =
  | { kind: 'text'; text: string; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'binary'; size: number }

/** GET /dsh-file-browser/<op>，信封 {ok:true,...}|{ok:false,error}。 */
async function fsGet<T>(
  op: 'list' | 'read',
  sessionId: string,
  query: { path?: string; abs?: string },
): Promise<T> {
  const params = new URLSearchParams({ sessionId })
  if (query.path !== undefined) params.set('path', query.path)
  if (query.abs !== undefined) params.set('abs', query.abs)
  const url = `/dsh-file-browser/${op}?${params.toString()}`
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new FsApiError('network')
  }
  interface Envelope { ok?: boolean; error?: FsErrorCode }
  let body: Envelope & T
  try {
    body = await res.json() as Envelope & T
  } catch {
    throw new FsApiError(res.status === 403 ? 'forbidden' : 'internal')
  }
  if (body.ok !== true) throw new FsApiError(body.error ?? 'internal')
  return body
}

/** 列一层目录（'' 为会话根）。 */
export function fsList(sessionId: string, relPath: string): Promise<FsListing> {
  return fsGet<FsListing>('list', sessionId, { path: relPath })
}

/** 读文件内容（三态：文本/过大/二进制）。路径为会话 root 相对。 */
export async function fsRead(sessionId: string, relPath: string): Promise<FsFileContent> {
  const body = await fsGet<{ text?: string; size?: number; tooLarge?: boolean; binary?: boolean }>(
    'read', sessionId, { path: relPath })
  return fileContentOf(body)
}

/**
 * 读工作区外单个文件（三态同 {@link fsRead}）。`absPath` 必须是
 * {@link absoluteFilePath} 的产物（规范化绝对路径）；Host 侧仍要求有效
 * 会话与信任栅栏，但不做工作区边界校验——这正是该通道的特性。
 */
export async function fsReadAbsolute(sessionId: string, absPath: string): Promise<FsFileContent> {
  const body = await fsGet<{ text?: string; size?: number; tooLarge?: boolean; binary?: boolean }>(
    'read', sessionId, { abs: absPath })
  return fileContentOf(body)
}

/** wire 信封 → 三态内容投影（read 两形态共用）。 */
function fileContentOf(body: { text?: string; size?: number; tooLarge?: boolean; binary?: boolean }): FsFileContent {
  const size = body.size ?? 0
  if (body.tooLarge === true) return { kind: 'too-large', size }
  if (body.binary === true) return { kind: 'binary', size }
  return { kind: 'text', text: body.text ?? '', size }
}

/**
 * The structured envelope observation seam exposed by the shared connection
 * client. The real carrier owns the WebSocket/SSE physical stream and already
 * batches envelopes at microtask boundaries; file-browser must only observe
 * that seam, never open a second `/api/events.mux` connection of its own.
 *
 * This is intentionally a small structural mirror rather than an import from
 * the upstream client source. All four RpcMessage forms have a string `type`;
 * only server-request envelopes carry the optional `method`/`payload` fields
 * consumed below.
 */
export interface EnvelopeMessage {
  type: string
  method?: string
  payload?: unknown
}

export interface EnvelopeSource {
  subscribeEnvelopes: (listener: (batch: readonly EnvelopeMessage[]) => void) => () => void
}

/** mux 帧的用到切片（宽容探测：未知结构直接跳过）。 */
export interface MuxFrameLite {
  type: 'session/event'
  sessionId: string
  view?: { for?: string; view?: Record<string, unknown> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Narrow an observed server-request payload to the file-activity frame shape.
 * Unknown/malformed payloads are ignored just like malformed carrier frames;
 * the shared connection client remains the owner of wire-level validation.
 */
function asMuxFrame(value: unknown): MuxFrameLite | undefined {
  if (!isRecord(value) || value.type !== 'session/event' || typeof value.sessionId !== 'string') return undefined
  const rawView = value.view
  return {
    type: 'session/event',
    sessionId: value.sessionId,
    ...(isRecord(rawView)
      ? { view: rawView as MuxFrameLite['view'] }
      : {}),
  }
}

/**
 * Observe the shared connection envelope batches and forward only
 * `server-request` envelopes whose method/payload is `session/event`.
 * Returning the source disposer keeps subscription ownership with the caller.
 */
export function openMux(source: EnvelopeSource, onFrame: (frame: MuxFrameLite) => void): () => void {
  return source.subscribeEnvelopes((batch) => {
    for (const message of batch) {
      if (message.type !== 'server-request' || message.method !== 'session/event') continue
      const frame = asMuxFrame(message.payload)
      if (frame !== undefined) onFrame(frame)
    }
  })
}

/**
 * 从目标 session 的 mux 帧提取文件活动路径（tool 视图的
 * diffs/locations/read 三路；视图结构按属性存在性探测，不钉判别式——
 * 上游视图形状演进时保持钝感）。路径保持首见顺序并去重。
 */
export function fileActivityPaths(frame: MuxFrameLite, targetSessionId: string): string[] {
  if (frame.type !== 'session/event' || frame.sessionId !== targetSessionId) return []
  const view = frame.view?.view
  if (view === undefined || typeof view !== 'object') return []
  const paths: string[] = []
  const seen = new Set<string>()
  const add = (path: unknown): void => {
    if (typeof path !== 'string' || seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }
  const diffs = view['diffs']
  if (Array.isArray(diffs)) {
    for (const diff of diffs) {
      add((diff as { path?: unknown })?.path)
    }
  }
  const locations = view['locations']
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      add((loc as { path?: unknown })?.path)
    }
  }
  if (view['card'] === 'read') add(view['path'])
  return paths
}
