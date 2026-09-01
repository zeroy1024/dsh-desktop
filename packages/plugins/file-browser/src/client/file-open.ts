/**
 * Cross-plugin file-open handoff primitives.
 *
 * The chat side only knows the authored path from a message. The file-browser
 * page needs a session-relative POSIX path, so path conversion stays here as a
 * pure function and the handoff itself stays in a small observable mailbox.
 * Keeping both pieces independent makes the seam usable without a DOM event or
 * a global mutable singleton.
 */

/** Maximum number of pending open requests retained by a mailbox. */
export const FILE_OPEN_MAILBOX_MAX = 32

/** The data carried from a chat file link to the file-browser page. */
export interface FileOpenRequest {
  /** Unique correlation id for this enqueue, even when paths are repeated. */
  id: string
  /** Session whose workspace contains `relPath`. */
  sessionId: string
  /** Canonical absolute POSIX workspace root. */
  cwd: string
  /** Path as authored by the source UI (absolute or workspace-relative). */
  path: string
  /** Safe POSIX path relative to `cwd`; never starts with `/`. */
  relPath: string
}

/** Cross-plugin request accepted by the optional file-browser service. */
export interface FileBrowserOpenCommand {
  sessionId: string
  cwd?: string
  /** Absolute Host path preferred; safe relative POSIX paths are also accepted. */
  path: string
}

/** Optional client service consumed lazily by conversation file links. */
export interface FileBrowserOpenService {
  /**
   * Three-state handoff: resolved `true` means accepted by the internal
   * browser, resolved `false` asks the caller to use its fallback, and a
   * rejection means the internal opener failed and must remain visible to the
   * caller (it must not be silently converted into a second open attempt).
   */
  tryOpen: (command: FileBrowserOpenCommand) => Promise<boolean>
}

/** Input accepted by request builders and the mailbox. */
export type FileOpenRequestInput = Omit<FileOpenRequest, 'id'> & { id?: string }

/** Options for deterministic mailbox ids in tests or an embedding host. */
export interface FileOpenMailboxOptions {
  idFactory?: () => string
}

/** Observable, bounded FIFO queue for requests awaiting page ownership. */
export interface FileOpenMailbox {
  /** Subscribe to queue changes; the returned disposer is idempotent. */
  subscribe: (listener: () => void) => () => void
  /** Stable immutable snapshot until the queue changes. */
  getSnapshot: () => readonly FileOpenRequest[]
  /** Append a request and return the request with its assigned id. */
  enqueue: (input: FileOpenRequestInput) => FileOpenRequest
  /** Remove one request by id; returns false when it is no longer pending. */
  ack: (id: string) => boolean
  /** Remove and return all pending requests in FIFO order. */
  drain: () => readonly FileOpenRequest[]
}

let fallbackId = 0

/** Generate a correlation id without requiring a particular browser runtime. */
function defaultIdFactory(): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto)
  fallbackId += 1
  return `file-open-${fallbackId}`
}

/**
 * Build one request value. The optional id is useful when an embedding host
 * already has a correlation id; a mailbox still makes colliding ids unique.
 */
export function createFileOpenRequest(
  input: FileOpenRequestInput,
  idFactory: () => string = defaultIdFactory,
): FileOpenRequest {
  const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : idFactory()
  return Object.freeze({
    id,
    sessionId: input.sessionId,
    cwd: input.cwd,
    path: input.path,
    relPath: input.relPath,
  })
}

/**
 * Create a bounded observable FIFO mailbox.
 *
 * The snapshot is replaced only after a successful queue mutation. This gives
 * `useSyncExternalStore` consumers a stable reference between notifications.
 * Enqueueing never coalesces paths: two clicks on the same path are two
 * requests and receive two ids.
 */
export function createFileOpenMailbox(options: FileOpenMailboxOptions = {}): FileOpenMailbox {
  const idFactory = options.idFactory ?? defaultIdFactory
  let queue: FileOpenRequest[] = []
  let snapshot: readonly FileOpenRequest[] = Object.freeze([])
  const listeners = new Set<() => void>()
  let sequence = 0

  const emit = (): void => {
    snapshot = Object.freeze(queue.slice())
    // Iterate a copy so a callback may unsubscribe/subscribe without changing
    // this notification's delivery set.
    for (const listener of new Set(listeners)) listener()
  }

  const uniqueRequest = (input: FileOpenRequestInput): FileOpenRequest => {
    let request = createFileOpenRequest(input, idFactory)
    if (!queue.some(entry => entry.id === request.id)) return request

    // A host-provided id or a deterministic test factory may collide. Keep the
    // original id readable while making this enqueue independent and stable.
    const baseId = request.id || 'file-open'
    do {
      sequence += 1
      request = Object.freeze({ ...request, id: `${baseId}-${sequence}` })
    } while (queue.some(entry => entry.id === request.id))
    return request
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const getSnapshot = (): readonly FileOpenRequest[] => snapshot

  const enqueue = (input: FileOpenRequestInput): FileOpenRequest => {
    const request = uniqueRequest(input)
    queue = [...queue, request]
    if (queue.length > FILE_OPEN_MAILBOX_MAX) queue = queue.slice(-FILE_OPEN_MAILBOX_MAX)
    emit()
    return request
  }

  const ack = (id: string): boolean => {
    const index = queue.findIndex(request => request.id === id)
    if (index < 0) return false
    queue = [...queue.slice(0, index), ...queue.slice(index + 1)]
    emit()
    return true
  }

  const drain = (): readonly FileOpenRequest[] => {
    if (queue.length === 0) return snapshot
    const drained = snapshot
    queue = []
    emit()
    return drained
  }

  return { subscribe, getSnapshot, enqueue, ack, drain }
}

/** Reject path syntax that cannot safely be treated as a POSIX workspace path. */
function hasUnsafePathSyntax(path: string): boolean {
  return path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path)
}

/** Validate and canonicalize the absolute POSIX workspace root. */
function canonicalCwd(cwd: string): string | undefined {
  if (typeof cwd !== 'string' || cwd.length === 0 || hasUnsafePathSyntax(cwd)) return undefined
  // A double-leading slash is reserved here for UNC input. It is not needed
  // for a workspace root and accepting it would make the platform ambiguous.
  if (!cwd.startsWith('/') || cwd.startsWith('//')) return undefined
  if (cwd === '/') return cwd

  const withoutTrailingSlash = cwd.replace(/\/+$/, '')
  if (withoutTrailingSlash.length === 0) return '/'
  const segments = withoutTrailingSlash.slice(1).split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return withoutTrailingSlash
}

/** Validate a non-empty relative POSIX path and retain its authored spelling. */
function safeRelativePath(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path === '.' || hasUnsafePathSyntax(path)) return undefined
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return undefined
  return path
}

/**
 * Convert an authored path into a workspace-relative POSIX path.
 *
 * Absolute paths must be inside `cwd` with a component boundary (`/repo2` is
 * not under `/repo`). Relative paths are already interpreted under `cwd`, but
 * traversal and ambiguous platform syntax are rejected rather than normalized.
 * Returning `undefined` is the caller's signal to use the system opener.
 */
export function toWorkspaceRelativePath(authoredPath: string, cwd: string): string | undefined {
  const root = canonicalCwd(cwd)
  if (root === undefined || typeof authoredPath !== 'string' || authoredPath.length === 0) return undefined
  if (hasUnsafePathSyntax(authoredPath)) return undefined

  if (!authoredPath.startsWith('/')) return safeRelativePath(authoredPath)
  if (authoredPath.startsWith('//')) return undefined

  const rootPrefix = root === '/' ? '/' : `${root}/`
  if (authoredPath !== root && !authoredPath.startsWith(rootPrefix)) return undefined
  const relative = root === '/' ? authoredPath.slice(1) : authoredPath.slice(rootPrefix.length)
  return safeRelativePath(relative)
}
