/**
 * 预览列：文件 tab 条 + 面包屑 + 动作（打开 ▾ 系统默认应用 / 复制路径）+
 * 主体（markdown 文档渲染 / 源码高亮切换 / 大文件与二进制降级 / 错误态）。
 * 所有数据态由页面层拉取后经 props 下发（本组件零异步）。
 *
 * Markdown 渲染用本插件的 MarkdownDocument（README 语义：消毒后的 HTML、
 * 相对图片经 raw 路由、锚点滚动、仓内链接经 onOpenDocument 在 tab 内打开），
 * 不再用聊天侧的 MarkdownText——后者为不可信 assistant 输出把 HTML 与相对
 * URL 一律字面化，是成文契约而非缺陷。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, CodeBlock, IconBrowseOutline16, IconChevronRightOutline14, IconCloseFill14, Menu,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useHorizontalTabScroll } from '@dsh-desktop/panel-shell/client'
import { documentParent } from './document-links.ts'
import { isExternalFilePath } from './file-open.ts'
import type { FileTabsState } from './file-tabs.ts'
import type { FsFileContent } from './api.ts'
import type { Translate } from './types.ts'
import { langFromName } from './lang.ts'
import { shouldUseRichPreview } from './preview-policy.ts'
import { MarkdownDocument } from './MarkdownDocument.tsx'
import type { DocumentRenderContext } from './markdown-document.ts'
import { rawImageUrl } from '../fs-route.ts'
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
  /** 会话 id（raw 图片路由的锚点参数）。 */
  sessionId: string
  /** 当前会话的 canonical root（外部绝对 key 的 baseDir 换算用）。 */
  root: string | null
  canOpenPath: boolean
  onActivate: (relPath: string) => void
  onClose: (relPath: string) => void
  /** 「打开 ▾ → 用系统默认应用打开」：页面层拼 root 调 host.openPath。 */
  onOpenSystem: (relPath: string) => void
  /** 文档内相对链接点击：页面层在 tab 内打开（key 域与工作区/外部一致）。 */
  onOpenDocument: (relKey: string) => void
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
  // 复制反馈与 rewind CopyAction / 上游 HoverCard 同款：成功才交换文案，1s 还原；
  // writeClipboard 返回 false（权限拒绝等）时保持原样，不做虚假反馈。
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  return (
    <div className={css.plainPreview}>
      <div className={css.plainPreviewHead}>
        <span>{t('status.plain')}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (copied) return
            void writeClipboard(text).then((ok) => {
              if (!ok) return
              setCopied(true)
              timer.current = setTimeout(() => {
                timer.current = null
                setCopied(false)
              }, 1000)
            })
          }}
        >
          {copied ? t('preview.copied') : t('preview.copy')}
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
  tabs, view, sessionId, root, canOpenPath, onActivate, onClose, onOpenSystem, onOpenDocument,
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
  // strip above that banner; MarkdownDocument and the plain fallback keep their
  // normal preview spacing.
  const codePreview = active !== null
    && view?.content?.kind === 'text'
    && richPreview
    && (!isMarkdown(name) || showSource)
  const tabsRef = useHorizontalTabScroll<HTMLDivElement>(active, tabs.openPaths.length)

  /**
   * 文档渲染上下文：当前文件所在目录决定相对 URL 的基准与边界语义。
   * 工作区 key → root 相对 baseDir + 允许 GitHub 式根相对（`/img.png` = 仓库根）；
   * 外部绝对 key → 绝对 baseDir + 拒绝根相对（脱离工作区没有"根"可言）。
   * 引用稳定（仅随文件/会话/根变化），MarkdownDocument 的重解析 memo 依赖它。
   */
  const documentContext = useMemo<DocumentRenderContext>(() => {
    const key = active ?? ''
    return {
      // 根形态 key 没有父目录（documentParent 返回 undefined）：此类 key 实为
      // 目录，read 必 400 is-directory，渲染路径不可达，降级 '' 仅为类型完备。
      baseDir: documentParent(key) ?? '',
      kind: external ? 'external-file' : 'workspace',
      imageSrcFor: (src, via) => rawImageUrl(sessionId, src, via),
    }
  }, [active, external, sessionId])

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
                    <IconCloseFill14 size={12} />
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
              <MarkdownDocument
                text={content.text}
                context={documentContext}
                t={t}
                onOpen={onOpenDocument}
              />
            )
          }
          return (
            <CodeBlock
              className={css.codeBlock}
              code={content.text}
              lang={langFromName(name)}
              copyLabel={t('preview.copy')}
              copiedLabel={t('preview.copied')}
            />
          )
        })()}
      </div>
    </div>
  )
})
