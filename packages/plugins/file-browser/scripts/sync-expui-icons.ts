/**
 * Rebuild the file-browser IntelliJ Platform icon pack from one pinned
 * intellij-community commit. Runtime code never talks to GitHub: this script
 * vendors, hashes and generates the static import map used by client.js.
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_REPOSITORY = 'https://github.com/JetBrains/intellij-community'
const SOURCE_COMMIT = '30e98f9c41acfd51be2ecb018c052436555b70eb'
const APACHE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0.txt'
const RAW_ROOT = `https://raw.githubusercontent.com/JetBrains/intellij-community/${SOURCE_COMMIT}`
const API_ROOT = 'https://api.github.com/repos/JetBrains/intellij-community'
const FILE_TYPES_DIR = 'platform/icons/src/expui/fileTypes'
const EXTRA_BASES = [
  'platform/icons/src/expui/nodes/folder',
  'platform/icons/src/language/go',
  'platform/icons/src/language/python',
  'platform/icons/src/language/rust',
] as const

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetRoot = join(packageRoot, 'src', 'client', 'assets', 'jetbrains')
const manifestPath = join(packageRoot, 'jetbrains-icons.manifest.json')
const noticePath = join(packageRoot, 'THIRD_PARTY_NOTICES')
const generatedModulePath = join(packageRoot, 'src', 'client', 'icon-assets.ts')

interface VariantRecord {
  path: string
  source: string
  sha256: string
  width: number
  height: number
  license: 'Apache-2.0'
  licenseEvidence: 'file-header' | 'repository-license'
}

interface AssetRecord {
  id: string
  light: VariantRecord
  dark: VariantRecord | null
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-desktop-expui-sync' } })
  if (!response.ok) throw new Error(`icon sync fetch failed (${String(response.status)}): ${url}`)
  return response.text()
}

async function sourcePaths(): Promise<string[]> {
  const response = await fetch(
    `${API_ROOT}/contents/${FILE_TYPES_DIR}?ref=${SOURCE_COMMIT}`,
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-expui-sync' } },
  )
  if (!response.ok) throw new Error(`icon sync listing failed (${String(response.status)})`)
  const entries = await response.json() as Array<{ name?: unknown; type?: unknown }>
  const names = entries
    .filter(entry => entry.type === 'file' && typeof entry.name === 'string' && entry.name.endsWith('.svg'))
    .map(entry => entry.name as string)
    .toSorted()
  if (names.length !== 139) {
    throw new Error(`pinned ExpUI fileTypes inventory drifted: expected 139 SVG, received ${String(names.length)}`)
  }
  return [
    ...names.map(name => `${FILE_TYPES_DIR}/${name}`),
    ...EXTRA_BASES.flatMap(base => [`${base}.svg`, `${base}_dark.svg`]),
  ].toSorted()
}

function validateSvg(sourcePath: string, svg: string): { width: number; height: number } {
  const root = svg.match(/<svg\b[^>]*>/u)?.[0]
  const width = Number(root?.match(/\bwidth="(\d+)"/u)?.[1])
  const height = Number(root?.match(/\bheight="(\d+)"/u)?.[1])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > 64 || height > 64) {
    throw new Error(`ExpUI asset has invalid dimensions: ${sourcePath}`)
  }
  const withoutInternalPaintServers = svg.replace(/url\(\s*["']?#[^)]+\)/giu, '')
  if (/<script\b|<!ENTITY\b|(?:href|xlink:href)=["']https?:|url\(/iu.test(withoutInternalPaintServers)) {
    throw new Error(`ExpUI asset contains an unsafe external/script construct: ${sourcePath}`)
  }
  return { width, height }
}

function localRelativePath(sourcePath: string): string {
  const prefix = 'platform/icons/src/'
  if (!sourcePath.startsWith(prefix)) throw new Error(`unexpected icon source path: ${sourcePath}`)
  return sourcePath.slice(prefix.length)
}

function packageRelativePath(path: string): string {
  return relative(packageRoot, path).split(sep).join('/')
}

function variantRecord(
  sourcePath: string,
  targetPath: string,
  svg: string,
  dimensions: { width: number; height: number },
): VariantRecord {
  const hasFileHeader = /^<!-- Copyright .*Apache 2\.0 license\./u.test(svg)
  return {
    path: packageRelativePath(targetPath),
    source: sourcePath,
    sha256: sha256(svg),
    width: dimensions.width,
    height: dimensions.height,
    license: 'Apache-2.0',
    licenseEvidence: hasFileHeader ? 'file-header' : 'repository-license',
  }
}

function assetId(sourcePath: string): string {
  const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1, -'.svg'.length)
  return name.endsWith('_dark') ? name.slice(0, -'_dark'.length) : name
}

function generatedModule(assets: readonly AssetRecord[]): string {
  const imports: string[] = []
  const entries: string[] = []
  assets.forEach((asset, index) => {
    const lightName = `asset${String(index)}Light`
    const darkName = `asset${String(index)}Dark`
    const lightImport = `./assets/jetbrains/${localRelativePath(asset.light.source)}`
    imports.push(`import ${lightName} from ${JSON.stringify(lightImport)}`)
    if (asset.dark === null) {
      entries.push(`  ${JSON.stringify(asset.id)}: pair(${lightName}, ${lightName}),`)
    } else {
      const darkImport = `./assets/jetbrains/${localRelativePath(asset.dark.source)}`
      imports.push(`import ${darkName} from ${JSON.stringify(darkImport)}`)
      entries.push(`  ${JSON.stringify(asset.id)}: pair(${lightName}, ${darkName}),`)
    }
  })
  return [
    '/**',
    ' * AUTO-GENERATED by scripts/sync-expui-icons.ts.',
    ` * Source: ${SOURCE_REPOSITORY}/tree/${SOURCE_COMMIT}`,
    ' * Do not edit this file or the vendored SVG directory by hand.',
    ' */',
    ...imports,
    '',
    'export interface IconAssetSources {',
    '  readonly light: string',
    '  readonly dark: string',
    '}',
    '',
    'function dataUrl(source: string): string {',
    '  return `data:image/svg+xml,${encodeURIComponent(source)}`',
    '}',
    '',
    'function pair(light: string, dark: string): IconAssetSources {',
    '  return { light: dataUrl(light), dark: dataUrl(dark) }',
    '}',
    '',
    'export const ICON_ASSETS = {',
    ...entries,
    '} as const satisfies Readonly<Record<string, IconAssetSources>>',
    '',
    'export type IconAssetId = keyof typeof ICON_ASSETS',
    '',
    'export function iconAssetSources(id: IconAssetId): IconAssetSources {',
    '  return ICON_ASSETS[id]',
    '}',
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const [paths, repositoryTerms, apacheLicense] = await Promise.all([
    sourcePaths(),
    fetchText(`${RAW_ROOT}/LICENSE.txt`),
    fetchText(APACHE_LICENSE_URL),
  ])
  const rows = await Promise.all(paths.map(async (sourcePath) => {
    const svg = await fetchText(`${RAW_ROOT}/${sourcePath}`)
    const dimensions = validateSvg(sourcePath, svg)
    return { sourcePath, svg, dimensions }
  }))

  await rm(assetRoot, { recursive: true, force: true })
  const variants = new Map<string, { light?: VariantRecord; dark?: VariantRecord }>()
  for (const row of rows) {
    const rel = localRelativePath(row.sourcePath)
    const targetPath = join(assetRoot, rel)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, row.svg, 'utf8')
    const id = assetId(row.sourcePath)
    const pair = variants.get(id) ?? {}
    const record = variantRecord(row.sourcePath, targetPath, row.svg, row.dimensions)
    if (row.sourcePath.endsWith('_dark.svg')) pair.dark = record
    else pair.light = record
    variants.set(id, pair)
  }

  const assets: AssetRecord[] = [...variants.entries()].map(([id, pair]) => {
    if (pair.light === undefined) throw new Error(`ExpUI asset has a dark variant without light: ${id}`)
    return { id, light: pair.light, dark: pair.dark ?? null }
  }).toSorted((a, b) => a.id.localeCompare(b.id))
  if (assets.length !== 76) {
    throw new Error(`ExpUI semantic inventory drifted: expected 76 assets, received ${String(assets.length)}`)
  }

  const manifest = {
    schemaVersion: 2,
    source: {
      repository: SOURCE_REPOSITORY,
      commit: SOURCE_COMMIT,
      commitUrl: `${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}`,
      license: 'Apache-2.0',
      licenseUrl: APACHE_LICENSE_URL,
      licenseSha256: sha256(apacheLicense),
      repositoryTermsPath: 'LICENSE.txt',
      repositoryTermsSha256: sha256(repositoryTerms),
      scopes: [
        FILE_TYPES_DIR,
        ...EXTRA_BASES,
      ],
    },
    assets,
  }
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(generatedModulePath, generatedModule(assets), 'utf8'),
    writeFile(noticePath, [
      '# Third-party notices',
      '',
      'This package vendors the IntelliJ Platform ExpUI file-tree asset pack listed in',
      '`jetbrains-icons.manifest.json`.',
      '',
      `Upstream project: JetBrains IntelliJ Community`,
      `Pinned source commit: ${SOURCE_COMMIT}`,
      `Source: ${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}`,
      'License: Apache License 2.0.',
      '',
      'Assets with their own Apache copyright header retain it verbatim. Assets without',
      'a per-file header are included under the pinned repository LICENSE.txt statement',
      'that the open-source software is subject to Apache 2.0. The repository terms',
      `SHA-256 is ${sha256(repositoryTerms)}. No trademark rights are granted.`,
      '',
      'The following is the Apache License 2.0 text:',
      '',
      apacheLicense.trimEnd(),
      '',
      'The following is the pinned repository LICENSE.txt / Open-Source Build Terms:',
      '',
      repositoryTerms.trimEnd(),
      '',
    ].join('\n'), 'utf8'),
  ])
  const repositoryEvidence = assets.flatMap(asset => [asset.light, asset.dark])
    .filter((variant): variant is VariantRecord => variant !== null)
    .filter(variant => variant.licenseEvidence === 'repository-license').length
  console.log(
    `synced ${String(rows.length)} SVG files into ${String(assets.length)} ExpUI assets `
    + `(${String(repositoryEvidence)} repository-license evidence variants)`,
  )
}

await main()
