/**
 * 从 CHANGELOG.md 提取目标版本章节并做结构校验，生成 GitHub Release 正文。
 *
 * Release 规范（AGENTS.md「Release 规范」）：CHANGELOG 是 Release 变更摘要的
 * 唯一来源；版本章节必须中英双语（中文在前、英文在后），比较基线须在 Full
 * Changelog 链接中固定，且不得含占位文本。本脚本把这些约束落成可执行校验：
 * 任一结构缺失直接报错退出，不静默回退为模板文案。双语「语义一致」仍由
 * 准备版本的维护者审阅，脚本只保证结构。
 *
 * CLI 用法（发布 workflow 与本地手工核对一致）：
 *   tsx scripts/release-notes.ts --changelog CHANGELOG.md --tag v0.1.3 --out release-notes.md
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Keep a Changelog 标准分类：中文 → 英文的固定配对。 */
const SECTION_TITLES: Readonly<Record<string, string>> = {
  新增: 'Added',
  改进: 'Changed',
  修复: 'Fixed',
  移除: 'Removed',
  弃用: 'Deprecated',
  安全: 'Security',
}
const ENGLISH_TITLES = new Set(Object.values(SECTION_TITLES))

/** 章节体内禁止出现的占位文本（大小写不敏感时由调用方处理，这里含大写形式即可）。 */
const PLACEHOLDER_PATTERNS = [/\bTBD\b/, /\bTODO\b/, /\bFIXME\b/, /\bPLACEHOLDER\b/, /占位/]

/** 版本章节标题行，如 `## [0.1.3] - 2026-09-10`。 */
const SECTION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/
/** 文件内的链接定义行，如 `[0.1.3]: https://.../compare/v0.1.2...v0.1.3`。 */
const LINK_DEFINITION = /^\[(\d+\.\d+\.\d+)\]: (\S+)$/

/** 分类标题解析结果：standard 是标准英文名，bilingual 标记是否为「中文 / English」形式。 */
interface ParsedTitle {
  standard: string
  bilingual: boolean
}

/**
 * 解析分类标题；返回 null 表示不是合法分类标题。
 * 接受两种形式：双语「新增 / Added」（中英必须配对正确）与纯英文「Added」。
 */
export function parseSectionTitle(line: string): ParsedTitle | null {
  const text = line.replace(/^#+\s*/, '').trim()
  const bilingual = text.match(/^(.+?)\s*\/\s*(.+)$/)
  if (bilingual !== null) {
    const [, chinese, english] = bilingual
    const expected = SECTION_TITLES[chinese.trim()]
    return expected !== undefined && expected === english.trim()
      ? { standard: expected, bilingual: true }
      : null
  }
  return ENGLISH_TITLES.has(text) ? { standard: text, bilingual: false } : null
}

/**
 * 从 CHANGELOG 全文截取目标版本的章节体（不含章节标题行，不含链接定义行）。
 * 章节体止于下一个 `## ` 章节标题或首个 `[x.y.z]:` 链接定义。
 */
export function extractSection(changelog: string, version: string): string {
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => {
    const match = line.match(SECTION_HEADING)
    return match !== null && match[1] === version
  })
  if (start === -1) {
    throw new Error(`CHANGELOG.md 中没有版本 ${version} 的章节（## [${version}] - 日期）`)
  }
  const end = lines.findIndex((line, index) =>
    index > start && (line.startsWith('## ') || LINK_DEFINITION.test(line)),
  )
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim()
}

/** 从全文链接定义区取目标版本的比较链接；基线必须是 `v` 开头的 tag 形式。 */
export function extractCompareUrl(changelog: string, version: string): string {
  for (const line of changelog.split('\n')) {
    const match = line.match(LINK_DEFINITION)
    if (match === null || match[1] !== version) continue
    const url = match[2]
    const compare = url.match(/\/compare\/(v[A-Za-z0-9.]+)\.\.\.v\d+\.\d+\.\d+$/)
    if (compare === null) {
      throw new Error(`版本 ${version} 的比较链接不是 tag 比较（.../compare/vX...vY）: ${url}`)
    }
    return url
  }
  throw new Error(`CHANGELOG.md 缺少版本 ${version} 的比较链接行（[${version}]: ...）`)
}

/**
 * 结构校验版本章节：
 * 1. 至少包含一个条目（`- ` 列表项）；
 * 2. 所有分类标题都是合法的双语或纯英文形式，双语与英文分类一一对应；
 * 3. 第一个分类标题必须是双语形式（中文在前）；
 * 4. 不含占位文本。
 */
export function validateSection(section: string, version: string): void {
  const fail = (reason: string): never => {
    throw new Error(`版本 ${version} 的 CHANGELOG 章节未通过校验：${reason}`)
  }
  if (!section.split('\n').some(line => line.trimStart().startsWith('- '))) {
    fail('章节内没有任何条目')
  }
  const titleLines = section.split('\n').filter(line => line.startsWith('###'))
  if (titleLines.length === 0) fail('章节内没有「新增 / Added」等分类标题')
  const parsed: ParsedTitle[] = []
  for (const title of titleLines) {
    const result = parseSectionTitle(title)
    if (result === null) {
      // 显式 throw（而非经由 fail）让 TS 把 result 窄化为非空。
      throw new Error(`版本 ${version} 的 CHANGELOG 章节未通过校验：分类标题不是合法的双语或英文形式：「${title}」`)
    }
    parsed.push(result)
  }
  const bilingual = parsed.filter(title => title.bilingual).map(title => title.standard)
  const english = parsed.filter(title => !title.bilingual).map(title => title.standard)
  if (bilingual.length === 0) fail('没有双语分类标题（中文说明缺失）')
  if (english.length === 0) fail('没有英文分类标题（英文说明缺失）')
  // 「中文在前」：首个分类标题必须带中文；每个双语分类在英文侧也有同分类标题。
  if (!parsed[0].bilingual) fail('第一个分类标题必须是双语形式（中文在前、英文在后）')
  for (const standard of new Set(bilingual)) {
    if (!english.includes(standard)) fail(`双语分类「${standard}」缺少对应的英文分类`)
  }
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(section)) fail(`章节内含占位文本（/${pattern.source}/）`)
  }
}

/** 固定的平台与签名说明尾注，随版本章节一起进入 Release 正文。 */
function releaseFooter(compareUrl: string): string {
  return [
    `**Full Changelog**: ${compareUrl}`,
    '',
    '---',
    '',
    'DeepSeek Harness developer preview. This release contains unsigned installers and portable archives for macOS arm64, Windows x64, and Linux x64. Verify downloaded files with SHA256SUMS before installing.',
    '',
    'Windows note: on first launch the app unpacks its bundled agent runtime into the user data directory (one-time, progress shown on the splash screen). If the NSIS installer itself is slow in your environment, the win-x64.zip archive works as a portable build — extract it with 7-Zip and run the executable directly.',
    '',
    'Linux note: the AppImage payload is FUSE-mounted and electron-builder strips the setuid bit while staging it, so the Chromium sandbox there falls back to kernel user namespaces; the generated AppRun probes user namespaces at startup and never disables the sandbox by itself. The portable tar.gz keeps the setuid chrome-sandbox helper (mode 4755) for environments where the traditional setuid sandbox works.',
  ].join('\n')
}

/** 校验并生成完整 Release 正文：版本章节 + Full Changelog + 平台说明。 */
export function buildReleaseNotes(changelog: string, version: string): string {
  const section = extractSection(changelog, version)
  validateSection(section, version)
  const compareUrl = extractCompareUrl(changelog, version)
  return `${section}\n\n${releaseFooter(compareUrl)}\n`
}

/** 简单的 `--key value` 参数解析；缺参或未知参数直接报错。独立的 `--` 分隔符跳过。 */
export function parseCliOptions(argv: readonly string[]): { changelog: string, tag: string, out: string } {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (key === '--') {
      // pnpm run 传参会保留 `--` 分隔符，跳过后继续按 key/value 成对解析。
      index -= 1
      continue
    }
    const value = argv[index + 1]
    if (!key.startsWith('--') || value === undefined) {
      throw new Error(`参数格式应为 --changelog <path> --tag vX.Y.Z --out <path>，收到：「${argv.join(' ')}」`)
    }
    values[key.slice(2)] = value
  }
  const { changelog, tag, out } = values
  if (changelog === undefined || tag === undefined || out === undefined) {
    throw new Error('缺少必填参数：--changelog <path> --tag vX.Y.Z --out <path>')
  }
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`tag 必须是 vX.Y.Z 形式，收到：「${tag}」`)
  return { changelog, tag, out }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { changelog, tag, out } = parseCliOptions(argv)
  const notes = buildReleaseNotes(readFileSync(changelog, 'utf8'), tag.slice(1))
  writeFileSync(out, notes)
  console.log(`release-notes: 版本 ${tag} 的 Release 正文已写入 ${out}`)
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`release-notes: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}
