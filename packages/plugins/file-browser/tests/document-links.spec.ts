/**
 * document-links 单测：URL 分类与相对路径解析（纯函数，无 DOM）。
 * 覆盖图片/链接/锚点/外链/拒绝五类，以及工作区与外部文件两个 baseDir 域。
 */
import { describe, expect, it } from 'vitest'
import { classifyAnchorHref, classifyImageSrc, resolveRelativePath, documentParent } from '../src/client/document-links.ts'
import type { DocumentPathContext } from '../src/client/document-links.ts'
import { rawImageUrl } from '../src/fs-route.ts'

/** 工作区文件 `docs/guide/intro.md` 的上下文（baseDir = docs/guide）。 */
const workspace: DocumentPathContext = { baseDir: 'docs/guide', kind: 'workspace' }
/** 外部绝对文件 `/Users/z/notes/readme.md` 的上下文（拒绝根相对）。 */
const external: DocumentPathContext = { baseDir: '/Users/z/notes', kind: 'external-file' }

describe('resolveRelativePath', () => {
  it('工作区相对：消化 . 与 ..，越出 root 返回 undefined', () => {
    expect(resolveRelativePath('docs/guide', 'img/a.png')).toBe('docs/guide/img/a.png')
    expect(resolveRelativePath('docs/guide', './a.png')).toBe('docs/guide/a.png')
    expect(resolveRelativePath('docs/guide', '../shared.png')).toBe('docs/shared.png')
    // ../../ 恰好弹到 root（docs/guide 深两层）：结果是 root 内文件，合法。
    expect(resolveRelativePath('docs/guide', '../../escape.png')).toBe('escape.png')
    expect(resolveRelativePath('docs/guide', '../../../escape.png')).toBeUndefined()
    expect(resolveRelativePath('', '../escape.png')).toBeUndefined()
  })

  it('外部绝对：base 以 / 开头则结果保持绝对', () => {
    expect(resolveRelativePath('/Users/z/notes', 'assets/pic.png')).toBe('/Users/z/notes/assets/pic.png')
    expect(resolveRelativePath('/Users/z/notes', '../other/x.png')).toBe('/Users/z/other/x.png')
    expect(resolveRelativePath('/a', '../../b')).toBeUndefined()
  })

  it('拒绝反斜杠、NUL 与空输入', () => {
    expect(resolveRelativePath('d', 'a\\b.png')).toBeUndefined()
    expect(resolveRelativePath('d', 'a\0b')).toBeUndefined()
    expect(resolveRelativePath('d', '')).toBeUndefined()
  })

  it('undefined 语义钉住：段消化后无剩余也拒绝；常规路径不被规范化复检误伤', () => {
    // 除 .. 越界外，折叠后一个段都不剩同样 undefined（JSDoc 列举的来源之一）。
    expect(resolveRelativePath('docs', '..')).toBeUndefined()
    expect(resolveRelativePath('', '.')).toBeUndefined()
    // 三类根下的常规折叠结果都能通过 absoluteFilePath 复检（该拒绝来源当前不可达）。
    expect(resolveRelativePath('/', 'a/./b.png')).toBe('/a/b.png')
    expect(resolveRelativePath('C:/docs', '../x.png')).toBe('C:/x.png')
    expect(resolveRelativePath('//server/share/docs', '../x.png')).toBe('//server/share/x.png')
  })
})

describe('classifyImageSrc', () => {
  it('绝对 http/https/data 原样（via=url）', () => {
    expect(classifyImageSrc('https://img.shields.io/b.svg', workspace))
      .toEqual({ kind: 'image', src: 'https://img.shields.io/b.svg', via: 'url' })
    expect(classifyImageSrc('data:image/png;base64,AAA', workspace))
      .toEqual({ kind: 'image', src: 'data:image/png;base64,AAA', via: 'url' })
  })

  it('工作区相对 → via=workspace，解析到当前目录', () => {
    expect(classifyImageSrc('img/a.png', workspace))
      .toEqual({ kind: 'image', src: 'docs/guide/img/a.png', via: 'workspace' })
  })

  it('GitHub 根相对（/x）→ 仓库根；外部文件模式拒绝', () => {
    expect(classifyImageSrc('/logo.png', workspace))
      .toEqual({ kind: 'image', src: 'logo.png', via: 'workspace' })
    expect(classifyImageSrc('/logo.png', external)).toEqual({ kind: 'blocked' })
  })

  it('外部文件模式下的相对图片 → via=external-file（绝对路径）', () => {
    expect(classifyImageSrc('assets/pic.png', external))
      .toEqual({ kind: 'image', src: '/Users/z/notes/assets/pic.png', via: 'external-file' })
  })

  it('percent 编码路径解码后解析', () => {
    expect(classifyImageSrc('my%20pic.png', workspace))
      .toEqual({ kind: 'image', src: 'docs/guide/my pic.png', via: 'workspace' })
  })

  it('越界、协议相对、空、纯片段 → blocked', () => {
    // baseDir=docs/guide 深两层：../../../ 才真正越出 root。
    expect(classifyImageSrc('../../../escape.png', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyImageSrc('//evil/x.png', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyImageSrc('', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyImageSrc('#frag', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyImageSrc('javascript:alert(1)', workspace)).toEqual({ kind: 'blocked' })
  })

  it('percent 解码出的反斜杠与 file: 协议 → blocked', () => {
    // %5C 解码后是 \（伪装成 POSIX 相对名的 Windows 分隔符）：拒绝而非放行。
    expect(classifyImageSrc('a%5Cb.png', workspace)).toEqual({ kind: 'blocked' })
    // file: 不在图片协议白名单（http/https/data）内。
    expect(classifyImageSrc('file:///C:/x.png', workspace)).toEqual({ kind: 'blocked' })
  })
})

describe('classifyAnchorHref', () => {
  it('外链协议 → external（保留原 href）', () => {
    expect(classifyAnchorHref('https://x.com/a', workspace)).toEqual({ kind: 'external', href: 'https://x.com/a' })
    expect(classifyAnchorHref('mailto:a@b.c', workspace)).toEqual({ kind: 'external', href: 'mailto:a@b.c' })
  })

  it('纯锚点 → anchor（解码目标）', () => {
    expect(classifyAnchorHref('#%E5%BF%AB%E9%80%9F%E5%BC%80%E5%A7%8B', workspace))
      .toEqual({ kind: 'anchor', target: '快速开始' })
    expect(classifyAnchorHref('#intro', workspace)).toEqual({ kind: 'anchor', target: 'intro' })
  })

  it('工作区相对文档 → document（root 相对 path）', () => {
    expect(classifyAnchorHref('../other.md', workspace))
      .toEqual({ kind: 'document', path: 'docs/other.md', absolute: false })
  })

  it('带片段的相对文档链接 → document + fragment', () => {
    expect(classifyAnchorHref('docs/x.md#sec', { baseDir: '', kind: 'workspace' }))
      .toEqual({ kind: 'document', path: 'docs/x.md', absolute: false, fragment: 'sec' })
  })

  it('外部文件模式下的相对链接 → document.absolute=true', () => {
    expect(classifyAnchorHref('other.md', external))
      .toEqual({ kind: 'document', path: '/Users/z/notes/other.md', absolute: true })
  })

  it('javascript:、越界、空、裸 # → blocked', () => {
    // baseDir=docs/guide 深两层：../../../ 才越出 root。
    expect(classifyAnchorHref('javascript:alert(1)', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyAnchorHref('../../../x.md', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyAnchorHref('', workspace)).toEqual({ kind: 'blocked' })
    expect(classifyAnchorHref('#', workspace)).toEqual({ kind: 'blocked' })
  })
})


describe('documentParent', () => {
  it('工作区嵌套文件 → 所在目录（FilePreview 文档上下文的生产路径）', () => {
    expect(documentParent('docs/guide/intro.md')).toBe('docs/guide')
    expect(documentParent('docs')).toBe('')
  })

  it('小写盘符同样保留为根', () => {
    expect(documentParent('c:/readme.md')).toBe('c:/')
  })

  it('根形态输入没有父目录 → undefined（钉住 parent ≠ 自身）', () => {
    expect(documentParent('/')).toBeUndefined()
    expect(documentParent('C:/')).toBeUndefined()
    // UNC 裸共享：`x.md` 会被识别为共享名，整个路径就是根。
    expect(documentParent('//server/share')).toBeUndefined()
    expect(documentParent('//server/share/')).toBeUndefined()
    expect(documentParent('//server/x.md')).toBeUndefined()
    // 不含任何段的空输入同样 undefined（FilePreview 对此降级为 ''）。
    expect(documentParent('')).toBeUndefined()
  })
})

describe('cross-platform document roots and image channels', () => {
  it.each([
    ['C:/README.md', 'C:/', 'C:/img/logo.png'],
    ['C:/docs/README.md', 'C:/docs', 'C:/docs/img/logo.png'],
    ['//server/share/README.md', '//server/share/', '//server/share/img/logo.png'],
    ['//server/share/docs/README.md', '//server/share/docs', '//server/share/docs/img/logo.png'],
    ['/README.md', '/', '/img/logo.png'],
    ['/docs/README.md', '/docs', '/docs/img/logo.png'],
  ])('opens relative images and links from %s using the absolute channel', (file, parent, target) => {
    expect(documentParent(file)).toBe(parent)
    const context: DocumentPathContext = { kind: 'external-file', baseDir: parent }
    const image = classifyImageSrc('img/logo.png', context)
    expect(image).toEqual({ kind: 'image', src: target, via: 'external-file' })
    if (image.kind !== 'image' || image.via === 'url') throw new Error('expected local image')
    const url = new URL(rawImageUrl('s', image.src, image.via), 'http://localhost')
    expect(url.searchParams.get('abs')).toBe(target)
    expect(url.searchParams.has('path')).toBe(false)
    expect(classifyAnchorHref('img/logo.png', context)).toEqual({ kind: 'document', path: target, absolute: true })
  })

  it.each(['C:/', '//server/share/', '/'])('does not traverse above %s', root => {
    expect(resolveRelativePath(root + 'docs', '../image.png')).toBe(root + 'image.png')
    expect(resolveRelativePath(root + 'docs', '../../image.png')).toBeUndefined()
  })

  it('preserves workspace root-relative semantics', () => {
    expect(documentParent('README.md')).toBe('')
    const image = classifyImageSrc('/img.png', { kind: 'workspace', baseDir: 'docs' })
    expect(image).toEqual({ kind: 'image', src: 'img.png', via: 'workspace' })
    expect(new URL(rawImageUrl('s', 'img.png', 'workspace'), 'http://localhost').searchParams.get('path')).toBe('img.png')
  })
})
