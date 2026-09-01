/**
 * File-browser split-pane preferences and geometry.
 *
 * The preference is deliberately independent from the session's open-file
 * ledger: the tree is a workspace navigation affordance, so its width and
 * visibility should follow the desktop user rather than a particular session.
 * All storage I/O is best-effort; the rendered layout remains usable when
 * storage is unavailable (private mode, quota exhaustion, or an older value).
 */

/** Minimum tree width that keeps the filter and file names usable. */
export const FILE_TREE_MIN_WIDTH = 160
/** Maximum tree width; the preview keeps the remainder of the panel. */
export const FILE_TREE_MAX_WIDTH = 320
/** Initial tree width, matching a compact IDE project view. */
export const FILE_TREE_DEFAULT_WIDTH = 200
/** The preview must retain enough width for its actions and readable content. */
export const FILE_PREVIEW_MIN_WIDTH = 160
/** Keyboard resize increment in CSS pixels. */
export const FILE_TREE_RESIZE_STEP = 16

export interface FileBrowserLayout {
  treeWidth: number
  treeHidden: boolean
}

export const defaultFileBrowserLayout: FileBrowserLayout = {
  treeWidth: FILE_TREE_DEFAULT_WIDTH,
  treeHidden: false,
}

/**
 * Rendered visibility combines the persisted manual preference with the
 * transient external-open episode. The latter is intentionally not written
 * into `layout.treeHidden`.
 */
export function effectiveFileTreeHidden(
  layout: FileBrowserLayout,
  externalTreeHidden: boolean,
  pendingExternalOpen = false,
): boolean {
  return layout.treeHidden || externalTreeHidden || pendingExternalOpen
}

/** One versioned key makes future preference migrations explicit. */
export const fileBrowserLayoutKey = 'dsh.filebrowser.layout.v1'

/** Clamp and normalize a width before it enters state, CSS, or storage. */
export function clampFileTreeWidth(width: number): number {
  if (!Number.isFinite(width)) return FILE_TREE_DEFAULT_WIDTH
  return Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, Math.round(width)))
}

/** Maximum tree width for the current pane while preserving the preview floor. */
export function fileTreeMaxWidthForAvailable(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return FILE_TREE_MAX_WIDTH
  return Math.min(
    FILE_TREE_MAX_WIDTH,
    Math.max(FILE_TREE_MIN_WIDTH, Math.floor(availableWidth - FILE_PREVIEW_MIN_WIDTH)),
  )
}

/** Rendered width: narrow panes concede without overwriting the saved preference. */
export function effectiveFileTreeWidth(preferredWidth: number, availableWidth: number): number {
  return Math.min(
    clampFileTreeWidth(preferredWidth),
    fileTreeMaxWidthForAvailable(availableWidth),
  )
}

/** Live width/range exposed by the splitter to assistive technology. */
export interface FileTreeGeometry {
  min: number
  max: number
  value: number
}

/**
 * Keep `aria-valuenow` in sync with the rendered width when a narrow panel
 * temporarily concedes a wider saved preference. The preference itself is
 * still retained for a later, wider panel.
 */
export function fileTreeGeometry(preferredWidth: number, availableWidth: number): FileTreeGeometry {
  const max = fileTreeMaxWidthForAvailable(availableWidth)
  return {
    min: FILE_TREE_MIN_WIDTH,
    max,
    value: Math.min(clampFileTreeWidth(preferredWidth), max),
  }
}

/** Defensive parser for localStorage values and schema drift. */
export function normalizeFileBrowserLayout(value: unknown): FileBrowserLayout {
  if (value === null || typeof value !== 'object') return defaultFileBrowserLayout
  const candidate = value as { treeWidth?: unknown; treeHidden?: unknown }
  const treeWidth = typeof candidate.treeWidth === 'number'
    ? clampFileTreeWidth(candidate.treeWidth)
    : FILE_TREE_DEFAULT_WIDTH
  const treeHidden = candidate.treeHidden === true
  return { treeWidth, treeHidden }
}

/** Read a layout preference; malformed or unavailable storage is harmless. */
export function loadFileBrowserLayout(
  storage: Pick<Storage, 'getItem'>,
): FileBrowserLayout {
  try {
    const raw = storage.getItem(fileBrowserLayoutKey)
    if (raw === null) return defaultFileBrowserLayout
    return normalizeFileBrowserLayout(JSON.parse(raw) as unknown)
  } catch {
    return defaultFileBrowserLayout
  }
}

/** Persist a validated preference; storage is a convenience, not the source of truth. */
export function saveFileBrowserLayout(
  storage: Pick<Storage, 'setItem'>,
  layout: FileBrowserLayout,
): void {
  try {
    storage.setItem(fileBrowserLayoutKey, JSON.stringify(normalizeFileBrowserLayout(layout)))
  } catch {
    // Quota/private-mode failures must not break resizing or hiding the tree.
  }
}
