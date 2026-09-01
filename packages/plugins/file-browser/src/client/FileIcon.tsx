/**
 * 文件树图标：目录、已知文件类型和未知文件类型都走同一份固定 commit
 * 生成的 IntelliJ Platform ExpUI SVG 资源包。资源在 icon-assets.ts 静态导入并在构建期
 * 内联，渲染层不再依赖宿主 folder primitive，也不保留自绘 fallback。
 */
import { memo } from 'react'
import { iconAssetSources } from './icon-assets.ts'
import { iconAssetOf } from './lang.ts'
import css from './FileIcon.module.css'

interface FileIconProps {
  /** 文件名（含扩展名）。 */
  name: string
  /** 目录行的开/合形态（保留调用契约；ExpUI folder 资产本身不分态）。 */
  dir?: boolean
  expanded?: boolean
}

/**
 * 渲染树行图标。
 * @param props - 见 {@link FileIconProps}。
 */
export const FileIcon = memo(function FileIcon({ name, dir = false }: FileIconProps) {
  // The fixed ExpUI folder asset intentionally represents both directory
  // states; expansion is conveyed by the row chevron, not a second icon.
  const assetId = dir ? 'folder' : iconAssetOf(name)
  const sources = iconAssetSources(assetId)
  return (
    <span className={css.icon} aria-hidden="true">
      <img className={css.iconLight} src={sources.light} width={16} height={16} alt="" draggable={false} />
      <img className={css.iconDark} src={sources.dark} width={16} height={16} alt="" draggable={false} />
    </span>
  )
})
