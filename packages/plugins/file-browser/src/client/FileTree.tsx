/**
 * 文件树列（受控展示组件）：行序列来自 flattenTree，用 @tanstack/react-virtual
 * 固定行高虚拟化（面板窄列下动辄数千行，上游 trajectory 同款方案）。
 * 行的加载/错误状态都从 TreeState 推导，本组件零异步。
 *
 * 选择模型（Codex 风格）：单击目录 = 展开/收起（并把它设为选区唯一成员）；
 * 单击文件 = 打开预览（替换选区）；⌘/⌃ 点击 = 切换成员；⇧ 点击 = 锚到目标
 * 的闭区间。选区与锚的计算是 tree-store 的纯函数（applySelection），本组件
 * 只读 props 里的 selection、把修饰键翻译成 SelectMode 上抛。
 */
import { memo, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './types.ts'
import type { SelectMode, TreeRow, TreeState } from './tree-store.ts'
import { FileIcon } from './FileIcon.tsx'
import css from './FileBrowser.module.css'

/** 行高与 CSS .row 的 height 一致（虚拟化几何的唯一契约）。 */
const ROW_HEIGHT = 22

export interface FileTreeProps {
  rows: TreeRow[]
  filter: string
  /** Hidden trees stay mounted; remeasure the virtual rows when restored. */
  visible: boolean
  /** Canonical absolute workspace path shown by the root row. */
  rootLabel: string
  /** 当前激活预览的 relPath（树行联动高亮）。 */
  selectedPath: string | null
  /** 多选集的成员 relPath 集。 */
  selection: ReadonlySet<string>
  onToggleDir: (relPath: string, expand: boolean) => void
  onOpenFile: (relPath: string) => void
  /** 行的修饰键选择（replace 时也回调，页面据此同步锚/激活）。 */
  onSelectRow: (key: string, mode: SelectMode) => void
  t: Translate
}

/** 鼠标事件 → 选择模式（⇧ 优先于 ⌘，与常见文件管理器一致）。 */
function modeOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): SelectMode {
  if (event.shiftKey) return 'range'
  if (event.metaKey || event.ctrlKey) return 'toggle'
  return 'replace'
}

/**
 * 渲染树列主体（不含筛选头——头在页面层，与 refresh 按钮同排）。
 * @param props - 见 {@link FileTreeProps}。
 */
export const FileTree = memo(function FileTree({
  rows, filter, visible, rootLabel, selectedPath, selection, onToggleDir, onOpenFile, onSelectRow, t,
}: FileTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  useLayoutEffect(() => {
    if (visible) virtualizer.measure()
  }, [virtualizer, visible])
  useLayoutEffect(() => {
    if (!visible || selectedPath === null) return
    const index = rows.findIndex(row => row.key === selectedPath)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [rows, selectedPath, virtualizer, visible])
  const items = virtualizer.getVirtualItems()
  // 树空态兜底：筛选无命中时显示空提示（根加载失败在行内显示错误）。
  const nothingFiltered = filter !== '' && rows.every(row => row.key === '' || row.isTruncatedNote === true)
  return (
    <div ref={scrollRef} className={css.treeScroller} role="tree" aria-label={t('tree.aria')}>
      <div className={css.treeInner} style={{ height: virtualizer.getTotalSize() }}>
        {items.map(item => {
          const row = rows[item.index]
          if (row.isTruncatedNote === true) {
            return (
              <div key={row.key} className={css.truncatedNote} style={{ transform: `translateY(${item.start}px)` }}>
                {t('tree.truncated')}
              </div>
            )
          }
          const isActive = row.key === selectedPath
          const isPicked = selection.has(row.key)
          return (
            <div
              key={row.key}
              role="treeitem"
              aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
              aria-selected={isPicked}
              className={[
                css.row,
                isActive && css.rowSelected,
                isPicked && !isActive && css.rowPicked,
              ].filter(Boolean).join(' ')}
              style={{
                transform: `translateY(${item.start}px)`,
                paddingInlineStart: `${4 + row.depth * 12}px`,
              }}
              onClick={(event) => {
                const mode = modeOf(event)
                // 多选语义只改选区；单击（replace）目录仍走展开、文件仍走打开。
                if (mode === 'replace') {
                  if (row.kind === 'dir') {
                    if (row.key !== '') onToggleDir(row.key, !row.expanded)
                  } else {
                    onOpenFile(row.key)
                  }
                }
                onSelectRow(row.key, mode)
              }}
            >
              {row.kind === 'dir'
                ? (
                    row.status === 'loading' && row.expanded
                      ? <span className={css.spinner} aria-hidden="true" />
                      : (
                          <span className={[css.chevron, row.expanded && css.chevronOpen].filter(Boolean).join(' ')} aria-hidden="true">
                            {row.key !== '' && <IconChevronRightOutline14 size={12} />}
                          </span>
                        )
                  )
                : <span className={css.chevron} aria-hidden="true" />}
              <span className={css.rowIcon}>
                <FileIcon name={row.name} dir={row.kind === 'dir'} expanded={row.expanded} />
              </span>
              <span className={css.rowLabel} title={row.key === '' ? rootLabel : row.name}>
                {row.key === '' ? rootLabel : row.name}
              </span>
              {row.kind === 'dir' && row.status === 'error' && (
                <span className={css.rowError}>{t('tree.error')}</span>
              )}
            </div>
          )
        })}
        {nothingFiltered && (
          <div className={css.truncatedNote}>{t('tree.emptyFilter')}</div>
        )}
      </div>
    </div>
  )
})

/** 供页面层复用的状态读取器（懒加载触发判断：目录未加载或错误时点击要拉取）。 */
export function dirNeedsLoad(state: TreeState, relPath: string): boolean {
  const dir = state.dirs.get(relPath)
  return dir === undefined || dir.status === 'error'
}
