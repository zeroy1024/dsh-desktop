import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const source = readFileSync(join(clientRoot, 'FilePreview.tsx'), 'utf8')
const css = readFileSync(join(clientRoot, 'FileBrowser.module.css'), 'utf8')

describe('file preview scroll layering', () => {
  it('removes the transparent strip only for sticky source-code previews', () => {
    expect(source).toContain('codePreview && css.codePreviewBody')
    expect(source).toContain('className={css.codeBlock}')
    expect(css).toMatch(/\.codePreviewBody\s*\{[^}]*padding-top:\s*0;/su)
    expect(css).toMatch(/\.codeBlock\s*\{[^}]*min-width:\s*0;[^}]*margin-top:\s*0;/su)
  })

  it('keeps scrolling CSS-owned and leaves markdown/plain branches separate', () => {
    expect(css).toMatch(/\.previewBody\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/su)
    expect(source).toContain('<PlainTextPreview text={content.text} t={t} />')
    // markdown 分支独立于 plain：走本插件的文档渲染器（README 语义）。
    expect(source).toContain('<MarkdownDocument')
    // 锚点滚动归 MarkdownDocument 内部；FilePreview 不做命令式滚动。
    expect(source).not.toMatch(/\b(?:scrollTop|scrollTo|scrollIntoView)\b/u)
  })
})
