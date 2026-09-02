/**
 * 预览列：文件 tab 条 + 面包屑 + 动作（打开 ▾ 系统默认应用 / 复制路径）+
 * 主体（markdown 渲染 / 源码高亮切换 / 大文件与二进制降级 / 错误态）。
 * 所有数据态由页面层拉取后经 props 下发（本组件零异步）。
 */
import { memo, useState } from 'react'
import {
  Button, CodeBlock, IconBrowseOutline16, IconChevronRightOutline14, MarkdownText, Menu,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useHorizontalTabScroll } from '@dsh-desktop/panel-shell/client'
import { isExternalFilePath } from './file-open.ts'
import type { FileTabsState } from './file-tabs.ts'
import type { FsFileContent } from './api.ts'
import type { Translate } from './types.ts'
import { langFromName } from './lang.ts'
import { shouldUseRichPreview } from './preview-policy.ts'
import { FileIcon } from './FileIcon.tsx'
import css from './FileBrowser.module.css'

/** 一个已打开文件的完整视图态（页面层持有 Map）。 */
export interface FileViewModel {
  content?: FsFileContent
  error?: string
  loading: boolean
}

export interface FilePreviewProps {
  tabs: FileTabsState
  /** 当前激活文件的视图态；无表项时视为 loading。 */
  view: FileViewModel | undefined
  /** 会话根（canonical）；拼绝对路径给 host.openPath。 */
  root: string | null
  canOpenPath: boolean
  onActivate: (relPath: string) => void
  onClose: (relPath: string) => void
  /** 「打开 ▾ → 用系统默认应用打开」：页面层拼 root 调 host.openPath。 */
  onOpenSystem: (relPath: string) => void
  /** 文件树隐藏时，预览列提供稳定的恢复入口。 */
  treeHidden: boolean
  onToggleTree: () => void
  t: Translate
}

/** 是否默认以渲染视图打开（视频语义：md 默认渲染，其余默认源码）。 */
function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name)
}

/** Native text control for payloads that deliberately bypass rich parsing. */
const PlainTextPreview = memo(function PlainTextPreview({ text, t }: { text: string; t: Translate }) {
  return (
    <div className={css.plainPreview}>
      <div className={css.plainPreviewHead}>
        <span>{t('status.plain')}</span>
        <Button size="sm" variant="outline" onClick={() => { void writeClipboard(text) }}>
          {t('preview.copy')}
        </Button>
      </div>
      <textarea
        className={css.plainText}
        value={text}
        readOnly
        wrap="off"
        spellCheck={false}
        aria-label={t('status.plain')}
      />
    </div>
  )
})

/**
 * 渲染预览列。
 * @param props - 见 {@link FilePreviewProps}。
 */
export const FilePreview = memo(function FilePreview({
  tabs, view, root, canOpenPath, onActivate, onClose, onOpenSystem,
  treeHidden, onToggleTree, t,
}: FilePreviewProps) {
  // 渲染/源码切换的会话内偏好（仅对 md 生效；不持久化——视频未演示跨重启）。
  const [showSource, setShowSource] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const active = tabs.activePath
  const name = active === null ? '' : active.slice(active.lastIndexOf('/') + 1)
  // key 的两个域：工作区相对路径（面包屑 = root 内相对链）与外部绝对路径
  // （面包屑 = 完整绝对路径分段；复制/系统打开直接用 key 本身）。
  const external = active !== null && isExternalFilePath(active)
  const crumbPrefix = active === null
    ? null
    : external
      ? (active.startsWith('//') ? '//' : active.startsWith('/') ? '/' : null)
      : '/'
  const crumbSegments = active === null
    ? []
    : external
      ? active.split('/').filter(segment => segment !== '')
      : active.split('/')
  const richPreview = view?.content?.kind === 'text'
    ? shouldUseRichPreview(view.content.size, view.content.text)
    : false
  // Only the source CodeBlock has the sticky language banner. Its wrapper gets
  // a top-padding/margin reset so the scrolled pre cannot appear in a clear
  // strip above that banner; MarkdownText and the plain fallback keep their
  // normal preview spacing.
  const codePreview = active !== null
    && view?.content?.kind === 'text'
    && richPreview
    && (!isMarkdown(name) || showSource)
  const tabsRef = useHorizontalTabScroll<HTMLDivElement>(active, tabs.openPaths.length)

  return (
    <div className={css.previewCol}>
      <div className={css.fileHeader}>
        {treeHidden && (
          <button
            data-file-tree-restore=""
            type="button"
            className={css.treeRestoreButton}
            aria-label={t('tree.show')}
            aria-controls="file-browser-tree"
            aria-expanded="false"
            title={t('tree.show')}
            onClick={onToggleTree}
          >
            <span aria-hidden="true"><IconChevronRightOutline14 size={14} /></span>
          </button>
        )}
        {tabs.openPaths.length > 0 && (
          <div ref={tabsRef} className={css.fileTabs} role="tablist" aria-label={t('tabs.aria')}>
            {tabs.openPaths.map(path => {
              const label = path.slice(path.lastIndexOf('/') + 1)
              const isActive = path === active
              return (
                <span
                  key={path}
                  role="tab"
                  aria-selected={isActive}
                  className={[css.fileTab, isActive && css.fileTabActive].filter(Boolean).join(' ')}
                  onClick={() => { onActivate(path) }}
                >
                  <FileIcon name={label} />
                  <span className={css.fileTabLabel}>{label}</span>
                  <button
                    type="button"
                    className={css.fileTabClose}
                    aria-label={`${t('tabs.close')}: ${label}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onClose(path)
                    }}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
      </div>

      {active !== null && (
        <div className={css.crumbBar}>
          <div className={css.crumbs}>
            {external && (
              <span className={css.crumbExternal} title={t('preview.external')}>
                {t('preview.external')}
              </span>
            )}
            {crumbPrefix !== null && (
              <span className={css.crumbText} title={crumbPrefix}>{crumbPrefix}</span>
            )}
            {crumbSegments.map((segment, index, all) => {
              const last = index === all.length - 1
              return (
                <span
                  key={`${index}/${segment}`}
                  className={[css.crumbSegment, last && css.crumbSegmentLast].filter(Boolean).join(' ')}
                >
                  <span className={css.crumbSep}>›</span>
                  <span
                    className={[css.crumbText, last && css.crumbLast].filter(Boolean).join(' ')}
                    title={segment}
                  >
                    {segment}
                  </span>
                </span>
              )
            })}
          </div>
          <div className={css.actions}>
            {isMarkdown(name) && view?.content?.kind === 'text' && richPreview && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setShowSource(value => !value) }}
              >
                {showSource ? t('preview.rendered') : t('preview.source')}
              </Button>
            )}
            <Menu
              open={menuOpen}
              align="end"
              anchor={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOpenPath}
                  icon={<IconBrowseOutline16 size={14} />}
                  onClick={() => { setMenuOpen(value => !value) }}
                >
                  {t('menu.open')} ▾
                </Button>
              }
              items={[
                { id: 'system', label: t('menu.openSystem') },
                { id: 'copy', label: t('menu.copyPath') },
              ]}
              onSelect={(id) => {
                setMenuOpen(false)
                if (active === null) return
                if (id === 'copy') {
                  // 外部 key 本身就是规范化绝对路径；工作区内拼 canonical root。
                  void writeClipboard(external ? active : root === null ? active : `${root}/${active}`)
                } else if (id === 'system') {
                  onOpenSystem(active)
                }
              }}
              onClose={() => { setMenuOpen(false) }}
              portal
            />
          </div>
        </div>
      )}

      <div className={[css.previewBody, codePreview && css.codePreviewBody].filter(Boolean).join(' ')}>
        {active === null && (
          <div className={css.empty}>
            <p className={css.emptyTitle}>{t('preview.empty.title')}</p>
            <p className={css.emptyGuide}>{t('preview.empty.guide')}</p>
          </div>
        )}
        {active !== null && view?.loading === true && (
          <p className={css.statusNote}>{t('status.loading')}</p>
        )}
        {active !== null && view?.error !== undefined && (
          <p className={css.statusNote}>{view.error}</p>
        )}
        {active !== null && view?.content !== undefined && (() => {
          const content = view.content
          if (content.kind === 'too-large') return <p className={css.statusNote}>{t('status.large')}</p>
          if (content.kind === 'binary') return <p className={css.statusNote}>{t('status.binary')}</p>
          if (!richPreview) return <PlainTextPreview text={content.text} t={t} />
          if (isMarkdown(name) && !showSource && richPreview) {
            return (
              <div className={css.markdownWrap}>
                <MarkdownText text={content.text} />
              </div>
            )
          }
          return (
            <CodeBlock
              className={css.codeBlock}
              code={content.text}
              lang={langFromName(name)}
              copyLabel={t('preview.copy')}
              copiedLabel={t('preview.copy')}
            />
          )
        })()}
      </div>
    </div>
  )
})
