import { describe, expect, it } from 'vitest'
import {
  RICH_PREVIEW_MAX_BYTES, RICH_PREVIEW_MAX_LINES, shouldUseRichPreview,
} from '../src/client/preview-policy.ts'

describe('rich preview policy', () => {
  it('keeps ordinary source and markdown on the rich path', () => {
    expect(shouldUseRichPreview(12, '# hello\n')).toBe(true)
    expect(shouldUseRichPreview(RICH_PREVIEW_MAX_BYTES, 'const ok = true')).toBe(true)
  })

  it('falls back to plain text for large or line-dense payloads', () => {
    expect(shouldUseRichPreview(RICH_PREVIEW_MAX_BYTES + 1, 'x')).toBe(false)
    expect(shouldUseRichPreview(1, '\n'.repeat(RICH_PREVIEW_MAX_LINES))).toBe(false)
  })

  it('uses string length when an older response has no usable size', () => {
    expect(shouldUseRichPreview(0, 'x'.repeat(RICH_PREVIEW_MAX_BYTES + 1))).toBe(false)
    expect(shouldUseRichPreview(Number.NaN, 'small')).toBe(true)
  })
})
