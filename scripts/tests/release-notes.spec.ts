import { describe, expect, it } from 'vitest'
import { buildReleaseNotes, extractCompareUrl, extractSection, parseCliOptions, parseSectionTitle, validateSection } from '../release-notes'

/** 构造一份符合 Release 规范的最小双语章节。 */
const validChangelog = `# Changelog

## [0.2.0] - 2026-09-10

### 新增 / Added

- 中文条目一。
- 中文条目二。

### 改进 / Changed

- 中文改进。

### Added

- English entry one.
- English entry two.

### Changed

- English change.

[0.2.0]: https://github.com/zeroy1024/dsh-desktop/compare/v0.1.3...v0.2.0

## [0.1.3] - 2026-09-01

### 修复 / Fixed

- 旧版本条目。

[0.1.3]: https://github.com/zeroy1024/dsh-desktop/compare/v0.1.2...v0.1.3
`

describe('extractSection', () => {
  it('截取目标版本章节体，止于下一章节或链接定义', () => {
    const section = extractSection(validChangelog, '0.2.0')
    expect(section).toContain('中文条目一。')
    expect(section).toContain('English entry two.')
    expect(section).not.toContain('[0.2.0]:')
    expect(section).not.toContain('旧版本条目。')
  })

  it('章节缺失时报错并给出目标版本', () => {
    expect(() => extractSection(validChangelog, '9.9.9'))
      .toThrow('CHANGELOG.md 中没有版本 9.9.9 的章节')
  })
})

describe('extractCompareUrl', () => {
  it('返回目标版本的 tag 比较链接', () => {
    expect(extractCompareUrl(validChangelog, '0.2.0'))
      .toBe('https://github.com/zeroy1024/dsh-desktop/compare/v0.1.3...v0.2.0')
  })

  it('缺少链接定义时报错', () => {
    expect(() => extractCompareUrl(validChangelog, '0.0.1'))
      .toThrow('比较链接行')
  })

  it('比较链接基线不是 tag 形式时报错', () => {
    const changelog = validChangelog.replace('compare/v0.1.3...v0.2.0', 'compare/main...v0.2.0')
    expect(() => extractCompareUrl(changelog, '0.2.0')).toThrow('tag 比较')
  })
})

describe('parseSectionTitle', () => {
  it('接受配对正确的双语标题', () => {
    expect(parseSectionTitle('### 新增 / Added')).toEqual({ standard: 'Added', bilingual: true })
  })

  it('中英配对错误或纯中文标题不合法', () => {
    expect(parseSectionTitle('### 新增 / Fixed')).toBeNull()
    expect(parseSectionTitle('### 新增')).toBeNull()
    expect(parseSectionTitle('### 未知 / Unknown')).toBeNull()
  })

  it('接受标准英文标题', () => {
    expect(parseSectionTitle('### Fixed')).toEqual({ standard: 'Fixed', bilingual: false })
  })
})

describe('validateSection', () => {
  it('通过规范的双语章节', () => {
    expect(() => validateSection(extractSection(validChangelog, '0.2.0'), '0.2.0')).not.toThrow()
  })

  it('没有任何条目时报错', () => {
    expect(() => validateSection('### 新增 / Added\n\n### Added\n', '0.2.0')).toThrow('没有任何条目')
  })

  it('缺少分类标题时报错', () => {
    expect(() => validateSection('- 只有条目。', '0.2.0')).toThrow('分类标题')
  })

  it('缺中文（无双语标题）时报错', () => {
    const section = extractSection(validChangelog, '0.2.0')
      .replace(/### 新增 \/ Added[\s\S]*?(?=### Added)/, '')
      .replace(/### 改进 \/ Changed[\s\S]*?(?=### Added)/, '')
    expect(() => validateSection(section, '0.2.0')).toThrow('中文说明缺失')
  })

  it('缺英文（无英文标题）时报错', () => {
    const section = extractSection(validChangelog, '0.2.0').replace(/### Added[\s\S]*$/, '')
    expect(() => validateSection(section, '0.2.0')).toThrow('英文说明缺失')
  })

  it('双语分类没有对应英文分类时报错', () => {
    const section = extractSection(validChangelog, '0.2.0').replace(/### Changed[\s\S]*$/, '')
    expect(() => validateSection(section, '0.2.0')).toThrow('缺少对应的英文分类')
  })

  it('第一个分类标题是纯英文时报错（中文必须在前）', () => {
    const section = ['### Added', '', '- English entry.', '', '### 新增 / Added', '', '- 中文条目。'].join('\n')
    expect(() => validateSection(section, '0.2.0')).toThrow('双语形式')
  })

  it('含占位文本时报错', () => {
    const section = extractSection(validChangelog, '0.2.0').replace('中文条目一。', 'TODO 待补充')
    expect(() => validateSection(section, '0.2.0')).toThrow('占位文本')
  })
})

describe('buildReleaseNotes', () => {
  const notes = buildReleaseNotes(validChangelog, '0.2.0')

  it('正文以双语章节开头，后接 Full Changelog 与平台说明', () => {
    expect(notes.indexOf('中文条目一。')).toBeLessThan(notes.indexOf('English entry one.'))
    expect(notes).toContain('**Full Changelog**: https://github.com/zeroy1024/dsh-desktop/compare/v0.1.3...v0.2.0')
    expect(notes).toContain('SHA256SUMS')
    expect(notes).toContain('Windows note')
    expect(notes).toContain('Linux note')
  })

  it('同一输入重复生成一致文案', () => {
    expect(buildReleaseNotes(validChangelog, '0.2.0')).toBe(notes)
  })
})

describe('parseCliOptions', () => {
  it('解析完整参数并要求 vX.Y.Z 形式的 tag', () => {
    expect(parseCliOptions(['--changelog', 'CHANGELOG.md', '--tag', 'v0.1.3', '--out', 'notes.md']))
      .toEqual({ changelog: 'CHANGELOG.md', tag: 'v0.1.3', out: 'notes.md' })
    expect(() => parseCliOptions(['--changelog', 'CHANGELOG.md', '--tag', '0.1.3', '--out', 'n.md']))
      .toThrow('vX.Y.Z')
    expect(() => parseCliOptions(['--changelog', 'CHANGELOG.md'])).toThrow('缺少必填参数')
  })

  it('跳过 pnpm 传入的 -- 分隔符', () => {
    expect(parseCliOptions(['--', '--changelog', 'CHANGELOG.md', '--tag', 'v0.1.3', '--out', 'notes.md']))
      .toEqual({ changelog: 'CHANGELOG.md', tag: 'v0.1.3', out: 'notes.md' })
  })
})
