/**
 * Synchronous Markdown/Shiki rendering is intentionally capped. The backend
 * may return text up to 2 MiB; parsing that entire payload on the renderer
 * main thread would turn a panel gesture into a long task. Larger or very
 * line-dense files remain readable through CodeBlock's plain-text path.
 */
export const RICH_PREVIEW_MAX_BYTES = 128 * 1024
export const RICH_PREVIEW_MAX_LINES = 4000

/** Whether a text payload is small enough for synchronous rich rendering. */
export function shouldUseRichPreview(size: number, text: string): boolean {
  const effectiveSize = Number.isFinite(size) && size > 0 ? size : text.length
  if (effectiveSize > RICH_PREVIEW_MAX_BYTES) return false

  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    lines += 1
    if (lines > RICH_PREVIEW_MAX_LINES) return false
  }
  return true
}
