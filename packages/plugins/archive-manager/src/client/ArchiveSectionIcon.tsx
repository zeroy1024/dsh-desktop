import { IconArchiveOutline20 } from '@deepseek-ai/dsh-client-ui-primitives'

/** The archive feature owns its nav glyph; the Settings shell supplies geometry. */
export function ArchiveSectionIcon({ className, size }: { className?: string; size: number }) {
  return <IconArchiveOutline20 className={className} size={size} />
}
