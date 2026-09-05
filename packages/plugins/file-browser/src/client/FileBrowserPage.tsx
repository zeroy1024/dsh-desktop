/**
 * 文件浏览器页面：编排层。持有树状态、筛选词、内部文件 tab 账本、各文件
 * 视图态、会话根与 canOpenPath。数据全走 api.ts 的 /api + /dsh-file-browser。
 * 懒加载：展开未加载目录时才拉取；根与会话随 sessionId 变化重置。
 * 联动刷新（阶段三）：active 时订阅 mux，工具事件的 diffs/locations/read
 * 命中已加载目录 → 局部重拉。切换 tab 不卸载（容器语义），故非 active 时
 * 停订阅、保留已加载状态。
 */
import {
  useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import {
  IconChevronLeftOutline14, IconCopyOutline16, IconRefreshOutline14, IconSearchOutline16, Input,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fsList, fsRead, fsReadAbsolute, openMux, fileActivityPaths,
  FsApiError, type FsFileContent, type FsErrorCode,
} from './api.ts'
import { absoluteFilePath, isExternalFilePath } from './file-open.ts'
import { createReadQueue } from './read-queue.ts'
import {
  applySelection, emptyTree, flattenTree, loadedPaths, withAncestorsExpanded, withDirState, withExpanded,
  type SelectMode, type TreeRow, type TreeState,
} from './tree-store.ts'
import {
  emptyFileTabs, loadFileTabs, saveFileTabs, openFile as openFileInTabs, closeFile, activateFile,
  relPathsUnderRoot, type FileTabsState,
} from './file-tabs.ts'
import { FileTree, dirNeedsLoad } from './FileTree.tsx'
import { FilePreview, type FileViewModel } from './FilePreview.tsx'
import { SplitPaneSeparator } from './SplitPaneSeparator.tsx'
import {
  clampFileTreeWidth, defaultFileBrowserLayout, FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MIN_WIDTH, FILE_TREE_RESIZE_STEP, fileTreeGeometry, fileTreeMaxWidthForAvailable,
  effectiveFileTreeHidden, loadFileBrowserLayout, saveFileBrowserLayout,
  type FileBrowserLayout,
} from './layout.ts'
import type { FilePageProps, Translate } from './types.ts'
import css from './FileBrowser.module.css'

const TREE_WIDTH_VARIABLE = '--dsh-file-tree-width'

interface SessionTabsState {
  sessionId: string | null
  tabs: FileTabsState
}

/** 错误码 → 词典键（'internal' 无专条，归到 unreadable 文案）。 */
function errorText(code: FsErrorCode, t: Translate): string {
  return t(code === 'internal' ? 'error.unreadable' : `error.${code}`)
}

/** 沿路径的目录链（含 target 自身；'' 恒在首）：'a/b' → ['', 'a', 'a/b']。 */
export function dirsAlongPath(relPath: string): string[] {
  if (relPath === '') return ['']
  const parts = relPath.split('/')
  const out = ['']
  for (let i = 1; i <= parts.length; i += 1) out.push(parts.slice(0, i).join('/'))
  return out
}

/**
 * 渲染文件浏览器页。
 * @param props - 容器注入（sessionId/active）+ 框架翻译座位。
 */
export function FileBrowserPage({ sessionId, active, fileOpenMailbox, envelopeSource, openPath, t }: FilePageProps) {
  const [tree, setTree] = useState<TreeState>(emptyTree)
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [tabState, setTabState] = useState<SessionTabsState>({ sessionId: null, tabs: emptyFileTabs })
  // The owner travels atomically with the ledger. During a session transition
  // the previous ledger is therefore never rendered, persisted, or focused;
  // the reset effect installs the new session's restored ledger in one state
  // update instead of relying on effect ordering between two setters.
  const sessionTabs = tabState.sessionId === sessionId ? tabState.tabs : emptyFileTabs
  const [views, setViews] = useState<ReadonlyMap<string, FileViewModel>>(new Map())
  const [root, setRoot] = useState<string | null>(null)
  const [canOpenPath, setCanOpenPath] = useState(false)
  const pendingFileOpens = useSyncExternalStore(
    fileOpenMailbox.subscribe,
    fileOpenMailbox.getSnapshot,
    fileOpenMailbox.getSnapshot,
  )
  // A conversation link hides the tree for this open episode only. Keep that
  // transient intent separate from the persisted manual preference, while a
  // pending request also participates in render-time visibility so the first
  // frame of a newly mounted page is already collapsed (no visible-tree flash).
  const [externalTreeHidden, setExternalTreeHidden] = useState(false)
  const externalTreeHiddenRef = useRef(false)
  const pendingExternalOpen = pendingFileOpens.some(request => request.sessionId === sessionId)
  const pendingExternalOpenRef = useRef(false)
  pendingExternalOpenRef.current = pendingExternalOpen
  // The tree layout is a user preference rather than a session resource. A
  // lazy read prevents the first render from overwriting an existing value;
  // subsequent writes happen only at interaction commit points.
  const [layoutPreference, setLayoutPreference] = useState<FileBrowserLayout>(() => (
    typeof localStorage === 'undefined' ? defaultFileBrowserLayout : loadFileBrowserLayout(localStorage)
  ))
  const layoutRef = useRef(layoutPreference)
  layoutRef.current = layoutPreference
  const rootRef = useRef<HTMLDivElement>(null)
  const availableWidthRef = useRef(0)
  const treeWidthRef = useRef(layoutPreference.treeWidth)
  // 多选态：选集驱动统一选中背景；锚只服务 ⇧ 范围选，不触发渲染。
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const filterCloseTimerRef = useRef<number | null>(null)

  // 最新状态镜像：异步链（懒加载循环、mux 回调）里读当前值而非渲染闭包旧值。
  const treeRef = useRef(tree)
  useLayoutEffect(() => { treeRef.current = tree }, [tree])
  const viewsRef = useRef(views)
  useLayoutEffect(() => { viewsRef.current = views }, [views])
  // The queue serializes each path and coalesces repeated tool invalidations.
  const reads = useRef(createReadQueue())
  const rowsRef = useRef<TreeRow[]>([])
  // 会话切换标记：sessionId 变化时整页重置。
  const lastSession = useRef<string | null>(null)
  // Async directory/file work can outlive a session switch. The current
  // session ref is updated synchronously by the reset effect, while the epoch
  // rejects any promise started before that effect. Keeping both checks avoids
  // an old closure (for example a revealDir loop) issuing work for a new epoch.
  const currentSessionRef = useRef(sessionId)
  const sessionEpochRef = useRef(0)

  // Establish the new-session fence in the layout phase. This runs before
  // passive effects (including the mailbox consumer) and before the browser
  // can paint the new session, so an old async completion cannot win the small
  // commit-to-effect window. The epoch-0 guard also makes StrictMode's second
  // effect pass idempotent on the initial mount.
  useLayoutEffect(() => {
    if (currentSessionRef.current === sessionId && sessionEpochRef.current > 0) return
    currentSessionRef.current = sessionId
    sessionEpochRef.current += 1
    treeRef.current = emptyTree
    viewsRef.current = new Map()
    rowsRef.current = []
    reads.current.clear()
    externalTreeHiddenRef.current = false
    setExternalTreeHidden(false)
  }, [sessionId])

  /** Write a layout CSS variable immediately and commit the preference once. */
  const applyTreeWidth = useCallback((width: number): number => {
    const geometry = fileTreeGeometry(width, availableWidthRef.current)
    treeWidthRef.current = geometry.value
    rootRef.current?.style.setProperty(TREE_WIDTH_VARIABLE, `${geometry.value}px`)
    const separator = rootRef.current?.querySelector<HTMLElement>('[data-file-tree-splitter]')
    separator?.setAttribute('aria-valuenow', String(geometry.value))
    separator?.setAttribute('aria-valuemax', String(geometry.max))
    return geometry.value
  }, [])

  const commitLayout = useCallback((next: FileBrowserLayout): void => {
    const normalized: FileBrowserLayout = {
      treeWidth: clampFileTreeWidth(next.treeWidth),
      treeHidden: next.treeHidden === true,
    }
    layoutRef.current = normalized
    setLayoutPreference(normalized)
    if (typeof localStorage !== 'undefined') saveFileBrowserLayout(localStorage, normalized)
  }, [])

  const commitTreeWidth = useCallback((width: number): void => {
    const nextWidth = applyTreeWidth(width)
    commitLayout({ ...layoutRef.current, treeWidth: nextWidth })
  }, [applyTreeWidth, commitLayout])

  const readTreeWidth = useCallback((): number => treeWidthRef.current, [])
  const readTreeMax = useCallback((): number => (
    fileTreeMaxWidthForAvailable(availableWidthRef.current)
  ), [])

  const closeFilter = useCallback((): void => {
    if (filterCloseTimerRef.current !== null) {
      window.clearTimeout(filterCloseTimerRef.current)
      filterCloseTimerRef.current = null
    }
    setFilterOpen(false)
    setFilter('')
  }, [])

  const openFilter = useCallback((): void => {
    if (filterCloseTimerRef.current !== null) {
      window.clearTimeout(filterCloseTimerRef.current)
      filterCloseTimerRef.current = null
    }
    setFilterOpen(true)
  }, [])

  const scheduleFilterClose = useCallback((): void => {
    if (filterCloseTimerRef.current !== null) window.clearTimeout(filterCloseTimerRef.current)
    // blur precedes a clicked tree row's click event. A short deferral lets
    // that selection land before clearing the filtered row sequence.
    filterCloseTimerRef.current = window.setTimeout(closeFilter, 100)
  }, [closeFilter])

  useEffect(() => () => {
    if (filterCloseTimerRef.current !== null) window.clearTimeout(filterCloseTimerRef.current)
  }, [])

  // Outer-panel resize/expand should concede the rendered tree width without
  // rewriting the saved preference. Geometry stays on the DOM/CSS path so an
  // animated panel does not re-render the virtual tree or code preview.
  useLayoutEffect(() => {
    const element = rootRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    let frame: number | null = null
    let latestWidth = element.clientWidth
    const sync = (): void => {
      frame = null
      if (latestWidth <= 0) return
      availableWidthRef.current = latestWidth
      applyTreeWidth(layoutRef.current.treeWidth)
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      latestWidth = Math.floor(entry.contentRect.width)
      frame ??= window.requestAnimationFrame(sync)
    })
    observer.observe(element)
    sync()
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [applyTreeWidth])

  const toggleTree = useCallback((): void => {
    const treeHidden = !(
      layoutRef.current.treeHidden
      || externalTreeHiddenRef.current
      || pendingExternalOpenRef.current
    )
    if (!treeHidden) {
      externalTreeHiddenRef.current = false
      setExternalTreeHidden(false)
    }
    if (treeHidden) closeFilter()
    commitLayout({ ...layoutRef.current, treeHidden })
    window.requestAnimationFrame(() => {
      const selector = treeHidden ? '[data-file-tree-restore]' : '[data-file-tree-splitter]'
      rootRef.current?.querySelector<HTMLElement>(selector)?.focus()
    })
  }, [closeFilter, commitLayout])

  /**
   * External chat links open the file page in a focused preview state. Record
   * that visible state as a transient episode; the persisted manual preference
   * remains untouched. Tree clicks, tab activation, and restored tabs never
   * call this.
   */
  const collapseTreeForExternalOpen = useCallback((): void => {
    if (layoutRef.current.treeHidden || externalTreeHiddenRef.current) return
    closeFilter()
    externalTreeHiddenRef.current = true
    setExternalTreeHidden(true)
  }, [closeFilter])

  /** 拉取一层目录并落地状态（force 忽略「已加载」直接重拉）。 */
  const loadDir = useCallback(async (relPath: string, force = false): Promise<void> => {
    const epoch = sessionEpochRef.current
    if (currentSessionRef.current !== sessionId) return
    if (!force && !dirNeedsLoad(treeRef.current, relPath)) return
    return reads.current.run(`dir:${relPath}`, async (isCurrent) => {
      if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId) return
      if (treeRef.current.dirs.get(relPath)?.status !== 'ready') {
        setTree(prev => withDirState(prev, relPath, { status: 'loading' }))
      }
      try {
        const listing = await fsList(sessionId, relPath)
        if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId || !isCurrent()) return
        setRoot(current => current ?? listing.root)
        setTree(prev => withDirState(prev, relPath, {
          status: 'ready', entries: listing.entries, truncated: listing.truncated,
        }))
      } catch (err) {
        if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId || !isCurrent()) return
        setTree(prev => withDirState(prev, relPath, {
          status: 'error', error: err instanceof FsApiError ? err.code : 'unreadable',
        }))
      }
    }, force)
  }, [sessionId])

  // 会话就绪/切换：重置 + 拉根目录 + 恢复 tab 账本。
  useEffect(() => {
    if (lastSession.current === sessionId) return
    lastSession.current = sessionId
    treeRef.current = emptyTree
    setTree(emptyTree)
    const resetViews = new Map<string, FileViewModel>()
    viewsRef.current = resetViews
    setViews(resetViews)
    setRoot(null)
    setCanOpenPath(false)
    setFilterOpen(false)
    setFilter('')
    setSelection(new Set())
    anchorRef.current = null
    rowsRef.current = []
    externalTreeHiddenRef.current = false
    setExternalTreeHidden(false)
    setTabState({ sessionId, tabs: loadFileTabs(localStorage, sessionId) })
    reads.current.clear()
    setCanOpenPath(true)
    // The previous tree may have had a loaded root. A new session must always
    // fetch its own root, even before React commits the emptyTree update.
    void loadDir('', true)
  }, [sessionId, loadDir])

  // tab 账本随会话持久化。
  useEffect(() => {
    if (tabState.sessionId !== sessionId) return
    saveFileTabs(localStorage, sessionId, sessionTabs)
  }, [sessionId, sessionTabs, tabState.sessionId])

  /** 展开/收起目录（首次展开懒加载）。 */
  const toggleDir = useCallback((relPath: string, expand: boolean) => {
    setTree(prev => {
      if (expand && dirNeedsLoad(prev, relPath)) void loadDir(relPath)
      return withExpanded(prev, relPath, expand)
    })
  }, [loadDir])

  /** Keep the ref and React state in lockstep for async read orchestration. */
  const commitViews = useCallback((next: ReadonlyMap<string, FileViewModel>): void => {
    viewsRef.current = next
    setViews(next)
  }, [])

  /** 读文件内容（视图缓存命中即跳过；force 将在途读标为过期并合并重读）。 */
  const ensureFile = useCallback(async (key: string, force = false): Promise<void> => {
    const epoch = sessionEpochRef.current
    if (currentSessionRef.current !== sessionId) return
    if (!force && viewsRef.current.has(key)) return
    return reads.current.run(`file:${key}`, async (isCurrent) => {
      if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId) return
      // Keep a previously rendered preview visible while refreshing it.
      if (!viewsRef.current.get(key)?.content) {
        const loading = new Map(viewsRef.current)
        loading.set(key, { loading: true })
        commitViews(loading)
      }
      try {
        const content: FsFileContent = await (isExternalFilePath(key)
          ? fsReadAbsolute(sessionId, key)
          : fsRead(sessionId, key))
        if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId || !isCurrent()) return
        const next = new Map(viewsRef.current)
        next.set(key, { loading: false, content })
        commitViews(next)
      } catch (err) {
        if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId || !isCurrent()) return
        const next = new Map(viewsRef.current)
        next.set(key, {
          loading: false,
          error: err instanceof FsApiError ? errorText(err.code, t) : t('error.unreadable'),
        })
        commitViews(next)
      }
    }, force)
  }, [commitViews, sessionId, t])

  /**
   * 定位文件：展开 relPath（目录）及其全部祖先，链上未加载层逐级拉取
   * （祖先的加载也喂 flatten，行才能出现）。
   */
  const revealDir = useCallback(async (relPath: string): Promise<void> => {
    const epoch = sessionEpochRef.current
    if (currentSessionRef.current !== sessionId) return
    setTree(prev => withExpanded(withAncestorsExpanded(prev, relPath), relPath, true))
    for (const dir of dirsAlongPath(relPath)) {
      if (sessionEpochRef.current !== epoch || currentSessionRef.current !== sessionId) return
      await loadDir(dir)
    }
  }, [loadDir, sessionId])

  /**
   * Focus one file consistently: select it, reveal its parent, and load it.
   * External keys live outside the tree: load content only — no selection and
   * no directory reveal (a slash-bearing absolute key is not a tree relPath).
   */
  const focusFile = useCallback((key: string, force = false): void => {
    void ensureFile(key, force)
    if (isExternalFilePath(key)) return
    setSelection(prev => prev.size === 1 && prev.has(key) ? prev : new Set([key]))
    anchorRef.current = key
    const separator = key.lastIndexOf('/')
    const parent = separator < 0 ? '' : key.slice(0, separator)
    void revealDir(parent)
  }, [ensureFile, revealDir])

  /** Update only the ledger owned by the current session. */
  const setSessionTabs = useCallback((next: FileTabsState | ((current: FileTabsState) => FileTabsState)): void => {
    setTabState(previous => {
      const current = previous.sessionId === sessionId ? previous.tabs : emptyFileTabs
      const updated = typeof next === 'function' ? next(current) : next
      return { sessionId, tabs: updated }
    })
  }, [sessionId])

  /** 打开文件 = 入 tab + 激活 + 统一聚焦。 */
  const handleOpenFile = useCallback((relPath: string) => {
    setSessionTabs(prev => openFileInTabs(prev, relPath))
    focusFile(relPath)
  }, [focusFile, setSessionTabs])

  /** 关闭后回落到统一聚焦 helper，确保回退 tab 有内容且在树中可见。 */
  const handleCloseFile = useCallback((relPath: string) => {
    const next = closeFile(sessionTabs, relPath)
    setSessionTabs(next)
    if (next.activePath === null) {
      setSelection(new Set())
      anchorRef.current = null
    } else if (next.activePath !== sessionTabs.activePath) {
      focusFile(next.activePath)
    }
  }, [focusFile, sessionTabs, setSessionTabs])

  /** 激活 tab 后同步选中/定位，避免仅更新 tab ledger。 */
  const handleActivateFile = useCallback((relPath: string) => {
    setSessionTabs(prev => activateFile(prev, relPath))
    focusFile(relPath)
  }, [focusFile, setSessionTabs])

  /** A write invalidates an in-flight read and queues one fresh read after it settles. */
  const refreshFile = useCallback((relPath: string): void => {
    if (!viewsRef.current.has(relPath)) return
    void ensureFile(relPath, true)
  }, [ensureFile])

  // Restored session tabs have no click event to trigger the focus path. The
  // active-path dependency also covers the first tab restored from storage.
  useEffect(() => {
    if (tabState.sessionId !== sessionId) return
    const activePath = sessionTabs.activePath
    if (activePath !== null) focusFile(activePath)
  }, [focusFile, sessionId, sessionTabs.activePath, tabState.sessionId])

  // Drain one request per render so rapid clicks keep their FIFO tab-opening
  // semantics. Content loading starts immediately; ancestor directory loads
  // run alongside it and later make the selected row scrollable.
  useEffect(() => {
    const request = pendingFileOpens.find(candidate => candidate.sessionId === sessionId)
    if (request === undefined) return
    collapseTreeForExternalOpen()
    // Hide before ack: the ack publishes a new mailbox snapshot, and a
    // synchronous subscriber render must not briefly reveal the tree between
    // those two state transitions.
    fileOpenMailbox.ack(request.id)
    handleOpenFile(request.relPath)
  }, [collapseTreeForExternalOpen, fileOpenMailbox, handleOpenFile, pendingFileOpens, sessionId])

  /** 「打开 ▾」的系统项：工作区外 key 本身即绝对路径；工作区内拼 canonical root。 */
  const handleOpenSystem = useCallback((key: string) => {
    if (isExternalFilePath(key)) {
      void openPath(key).catch(() => { /* 桌面能力缺位静默 */ })
      return
    }
    if (root === null) return
    const absolute = root === '/' ? `/${key}` : `${root}/${key}`
    void openPath(absolute).catch(() => { /* 桌面能力缺位静默 */ })
  }, [root, openPath])

  /** 手动刷新：已加载目录全量重拉 + 激活文件重读（展开集保留）。 */
  const refresh = useCallback(() => {
    for (const relPath of loadedPaths(treeRef.current)) {
      // The queue merges repeated invalidations while the current read settles.
      void loadDir(relPath, true)
    }
    const activePath = sessionTabs.activePath
    if (activePath !== null) {
      void ensureFile(activePath, true)
    }
  }, [loadDir, ensureFile, sessionTabs.activePath])

  /** mux 联动刷新：仅 active 时订阅；命中已加载目录局部重拉。 */
  useEffect(() => {
    if (!active) return
    const epoch = sessionEpochRef.current
    const muxSession = sessionId
    return openMux(envelopeSource, (frame) => {
      if (sessionEpochRef.current !== epoch || currentSessionRef.current !== muxSession) return
      const paths = fileActivityPaths(frame, muxSession)
      if (paths.includes('')) {
        // Re-entry, reconnect, or a tool with no path metadata: reconcile all
        // loaded directories and cached previews, including inactive tabs.
        for (const path of loadedPaths(treeRef.current)) void loadDir(path, true)
        for (const path of viewsRef.current.keys()) refreshFile(path)
        return
      }
      for (const path of paths) {
        const absolute = absoluteFilePath(path)
        if (absolute !== undefined) refreshFile(absolute)
      }
      if (root === null) return
      for (const rel of relPathsUnderRoot(root, paths)) {
        // Preview refresh does not depend on whether its parent tree is loaded.
        refreshFile(rel)
        const at = rel.lastIndexOf('/')
        const parent = at < 0 ? '' : rel.slice(0, at)
        if (!treeRef.current.dirs.has(parent)) continue // 父级从未加载则无需刷新
        void loadDir(parent, true)
      }
    })
  }, [active, envelopeSource, root, loadDir, refreshFile, sessionId])

  /** 行点击的选择分发：⌘ 切换 / ⇧ 范围（replace 的打开/展开动作在 FileTree 里）。 */
  const handleSelectRow = useCallback((key: string, mode: SelectMode) => {
    setSelection(prev => {
      const next = applySelection(rowsRef.current, prev, anchorRef.current, key, mode)
      anchorRef.current = next.anchor
      return next.selection
    })
  }, [])

  /** 复制选区路径（拼 canonical root；多选时逐行）。 */
  const copySelected = useCallback(() => {
    if (root === null) return
    const paths = [...selection].map(rel => (rel === '' ? root : `${root}/${rel}`))
    if (paths.length > 0) void writeClipboard(paths.join('\n'))
  }, [root, selection])

  const deferredFilter = useDeferredValue(filter)
  const rows = useMemo(() => flattenTree(tree, deferredFilter), [deferredFilter, tree])
  useEffect(() => { rowsRef.current = rows }, [rows])

  const treeHidden = effectiveFileTreeHidden(
    layoutPreference,
    externalTreeHidden || externalTreeHiddenRef.current,
    pendingExternalOpen,
  )
  const treeGeometry = fileTreeGeometry(layoutPreference.treeWidth, availableWidthRef.current)
  return (
    <div
      ref={rootRef}
      className={css.root}
      style={{ [TREE_WIDTH_VARIABLE]: `${treeWidthRef.current}px` } as CSSProperties}
    >
      <div id="file-browser-tree" className={css.treeCol} hidden={treeHidden}>
        <div className={css.treeHead}>
          {filterOpen
            ? (
                <Input
                  id="file-browser-filter"
                  className={css.filterWrap}
                  value={filter}
                  placeholder={t('tree.filter')}
                  aria-label={t('tree.filter')}
                  autoFocus
                  onBlur={scheduleFilterClose}
                  onChange={(event) => { setFilter(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    closeFilter()
                  }}
                />
              )
            : (
                <button
                  type="button"
                  className={[css.refreshButton, css.searchButton].join(' ')}
                  aria-label={t('tree.filter')}
                  aria-controls="file-browser-filter"
                  aria-expanded="false"
                  title={t('tree.filter')}
                  onClick={openFilter}
                >
                  <IconSearchOutline16 size={14} />
                </button>
              )}
          {selection.size > 1 && (
            <button type="button" className={css.refreshButton} aria-label={t('tree.copySelected')} title={t('tree.copySelected')} onClick={copySelected}>
              <IconCopyOutline16 size={14} />
            </button>
          )}
          <button type="button" className={css.refreshButton} aria-label={t('tree.refresh')} onClick={refresh}>
            <IconRefreshOutline14 size={14} />
          </button>
          <button
            type="button"
            className={css.treeActionButton}
            aria-label={t('tree.hide')}
            aria-controls="file-browser-tree"
            aria-expanded="true"
            title={t('tree.hide')}
            onClick={toggleTree}
          >
            <span aria-hidden="true"><IconChevronLeftOutline14 size={14} /></span>
          </button>
        </div>
        <FileTree
          rows={rows}
          filter={deferredFilter}
          visible={!treeHidden}
          rootLabel={root ?? t('page.title')}
          selectedPath={sessionTabs.activePath}
          selection={selection}
          onToggleDir={toggleDir}
          onOpenFile={handleOpenFile}
          onSelectRow={handleSelectRow}
          t={t}
        />
      </div>
      {!treeHidden && (
        <SplitPaneSeparator
          className={css.splitHandle}
          controls="file-browser-tree"
          label={t('tree.resize')}
          value={treeWidthRef.current}
          min={FILE_TREE_MIN_WIDTH}
          max={treeGeometry.max}
          defaultValue={FILE_TREE_DEFAULT_WIDTH}
          step={FILE_TREE_RESIZE_STEP}
          readValue={readTreeWidth}
          readMax={readTreeMax}
          onPreview={applyTreeWidth}
          onCommit={commitTreeWidth}
        />
      )}
      <FilePreview
        tabs={sessionTabs}
        view={sessionTabs.activePath === null ? undefined : views.get(sessionTabs.activePath)}
        root={root}
        canOpenPath={canOpenPath}
        onActivate={handleActivateFile}
        onClose={handleCloseFile}
        onOpenSystem={handleOpenSystem}
        treeHidden={treeHidden}
        onToggleTree={toggleTree}
        t={t}
      />
    </div>
  )
}
