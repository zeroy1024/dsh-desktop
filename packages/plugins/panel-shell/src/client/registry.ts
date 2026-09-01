/**
 * 页面元数据注册表（panelShell 服务的载体）：tab 条的事实来源。页面插件的
 * apply 经 `registerPage` 记录 tab 元数据并返回 disposer；与 `panel-shell.page`
 * 槽位占用两半配套，缺一由容器对账大声上报。纯内存状态（不持久化）——持久
 * 化的是容器 store 里的打开 tab 集合与激活 id（panel-store.ts）。
 */
import type { ReactNode } from 'react'

/** One panel page's tab-strip metadata (the `registerPage` contract). */
export interface PanelPageMeta {
  /** Stable page id; must equal the `panel-shell.page` slot entry id. */
  id: string
  /** Tab label; the page plugin localizes, the container never translates. */
  title: () => string
  /** Tab icon (16px slot, ui-primitives icon conventions). */
  icon?: ReactNode
  /** Sort weight in the "+" menu and the empty-state guide; absent sorts last, ties break by id. */
  order?: number
  /**
   * Unread/todo count reader; undefined renders nothing. The page calls
   * `notifyBadgeChange` when the count moves — the container re-reads on
   * every render and on each notification.
   */
  badge?: () => number | undefined
  /** Page visibility callback: fired when the page becomes the active tab. */
  onActivate?: () => void
  /** Page visibility callback: fired when the page stops being the active tab. */
  onDeactivate?: () => void
  /**
   * 会话相位要求：'required' 的页在无当前会话时整条不可见（tab 按钮与
   * 「+」菜单都过滤；账本保留，会话回来自动复现）；缺省 'either' 两相
   * 可见。文件浏览这类「根目录锚定会话工作区」的页取 required。
   */
  sessionMode?: 'required' | 'either'
}

/**
 * 页面在给定会话相位下是否可见。纯函数：tab 条过滤与单测共用一条判据。
 * @param meta - 页面元数据。
 * @param hasSession - 当前是否存在激活会话。
 */
export function isPageVisible(meta: PanelPageMeta, hasSession: boolean): boolean {
  return meta.sessionMode !== 'required' || hasSession
}

/**
 * Resolve the presentation-active page without rewriting the persisted tab
 * ledger. A session-required active page can disappear during the no-session
 * phase; the first visible tab temporarily takes over and the original active
 * id resumes automatically when the session returns.
 */
export function resolveVisibleActiveId(
  visibleIds: readonly string[],
  activeId: string | null,
): string | null {
  if (activeId !== null && visibleIds.includes(activeId)) return activeId
  return visibleIds[0] ?? null
}

/** Sort weight for metas without an explicit order: after every ordered page. */
const UNORDERED = Number.POSITIVE_INFINITY

/**
 * Pairing check between the two registration halves. Pure: the container's
 * apply-side watcher feeds it the registry list and the slot-ledger ids and
 * renders the result (null = clean). Any mismatch is a packaging bug —
 * either half alone can never drive a tab.
 * @param pages - the registered metadata list.
 * @param slotIds - the `panel-shell.page` slot entry ids on the ledger.
 * @returns the loud error text, or null when the halves pair up.
 */
export function reconcilePageHalves(
  pages: readonly PanelPageMeta[],
  slotIds: ReadonlySet<string>,
): string | null {
  const metaIds = new Set(pages.map(page => page.id))
  const orphanMeta = [...metaIds].filter(id => !slotIds.has(id))
  const orphanSlot = [...slotIds].filter(id => !metaIds.has(id))
  if (orphanMeta.length === 0 && orphanSlot.length === 0) return null
  const parts: string[] = []
  if (orphanMeta.length > 0) parts.push(`page metadata without a slot entry: ${orphanMeta.join(', ')}`)
  if (orphanSlot.length > 0) parts.push(`slot entries without page metadata: ${orphanSlot.join(', ')}`)
  return `panel-shell: ${parts.join('; ')}`
}

/**
 * Metadata registry + reconciliation-error seat. Observable (version counter)
 * so the container's tab strip re-renders on registration changes and badge
 * notifications.
 */
export class PanelShellController {
  #pages = new Map<string, PanelPageMeta>()
  #listeners = new Set<() => void>()
  #version = 0
  #reconcileError: string | null = null

  /**
   * Record one page's metadata. Duplicate ids fail loudly — an id collision
   * means two plugins claim one tab, which is a packaging bug, not a race.
   * @param meta - the page's tab-strip metadata.
   * @returns the disposer; removing the active page is the container's
   * fallback problem (it settles on the first remaining open tab).
   */
  registerPage(meta: PanelPageMeta): () => void {
    if (this.#pages.has(meta.id)) {
      throw new Error(`panel-shell: page id "${meta.id}" is already registered`)
    }
    this.#pages.set(meta.id, meta)
    this.#emit()
    return () => {
      if (this.#pages.get(meta.id) !== meta) return
      this.#pages.delete(meta.id)
      this.#emit()
    }
  }

  /** The registered metadata for one page id, or undefined. */
  page(id: string): PanelPageMeta | undefined {
    return this.#pages.get(id)
  }

  /** All registered metas, order-ascending (absent last), ties by id. */
  get pages(): readonly PanelPageMeta[] {
    return [...this.#pages.values()].toSorted((a, b) =>
      (a.order ?? UNORDERED) - (b.order ?? UNORDERED) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }

  /**
   * Badge-change notification: a page calls this after its count moves; the
   * container's version bump re-renders the strip and re-reads `badge()`.
   * @param _id - the notifying page's id (all badges re-read; reserved for
   * per-page invalidation if badge reads ever turn expensive).
   */
  notifyBadgeChange(_id?: string): void {
    this.#emit()
  }

  /** The current reconciliation error (registry ⟷ slot pairing), or null. */
  get reconcileError(): string | null {
    return this.#reconcileError
  }

  /** Seat the reconciliation result; called by the container's apply-side watcher. */
  setReconcileError(error: string | null): void {
    if (this.#reconcileError === error) return
    this.#reconcileError = error
    this.#emit()
  }

  /** Subscription for `useSyncExternalStore`; snapshots are the version counter. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Snapshot getter for `useSyncExternalStore`. */
  getVersion = (): number => this.#version

  #emit(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}
