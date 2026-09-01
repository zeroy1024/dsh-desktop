/** Generated IntelliJ Platform ExpUI pack integrity and provenance checks. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { langFromName } from '../src/client/lang.ts'

interface AssetVariant {
  path: string
  source: string
  sha256: string
  width: number
  height: number
  license: string
  licenseEvidence: 'file-header' | 'repository-license'
}

interface IconManifest {
  schemaVersion: number
  source: {
    repository: string
    commit: string
    commitUrl: string
    license: string
    licenseUrl: string
    licenseSha256: string
    repositoryTermsPath: string
    repositoryTermsSha256: string
    scopes: string[]
  }
  assets: Array<{
    id: string
    light: AssetVariant
    dark: AssetVariant | null
  }>
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(packageRoot, 'jetbrains-icons.manifest.json')
const assetRoot = join(packageRoot, 'src', 'client', 'assets', 'jetbrains')

function readManifest(): IconManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as IconManifest
}

function svgFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return svgFiles(path)
    return entry.isFile() && entry.name.endsWith('.svg') ? [path] : []
  })
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex')
}

function packageRelative(path: string): string {
  return relative(packageRoot, path).split(sep).join('/')
}

function svgDimensions(contents: string): { width: number; height: number } {
  const root = contents.match(/<svg\b[^>]*>/u)?.[0]
  return {
    width: Number(root?.match(/\bwidth="(\d+)"/u)?.[1]),
    height: Number(root?.match(/\bheight="(\d+)"/u)?.[1]),
  }
}

describe('file icon contracts', () => {
  it('does not change the source-preview language resolver', () => {
    expect(langFromName('main.js')).toBe('javascript')
    expect(langFromName('main.ts')).toBe('typescript')
    expect(langFromName('unknown.custom')).toBeUndefined()
  })
})

describe('generated IntelliJ Platform ExpUI manifest', () => {
  it('pins the complete file-tree pack to one official commit and license evidence', () => {
    const manifest = readManifest()
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.source.repository).toBe('https://github.com/JetBrains/intellij-community')
    expect(manifest.source.commit).toBe('30e98f9c41acfd51be2ecb018c052436555b70eb')
    expect(manifest.source.commitUrl).toBe(`${manifest.source.repository}/commit/${manifest.source.commit}`)
    expect(manifest.source.license).toBe('Apache-2.0')
    expect(manifest.source.licenseUrl).toBe('https://www.apache.org/licenses/LICENSE-2.0.txt')
    expect(manifest.source.licenseSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(manifest.source.repositoryTermsPath).toBe('LICENSE.txt')
    expect(manifest.source.repositoryTermsSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(manifest.source.scopes).toEqual(expect.arrayContaining([
      'platform/icons/src/expui/fileTypes',
      'platform/icons/src/expui/nodes/folder',
      'platform/icons/src/language/go',
      'platform/icons/src/language/python',
      'platform/icons/src/language/rust',
    ]))

    expect(manifest.assets).toHaveLength(76)
    const ids = manifest.assets.map(asset => asset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'Csharp', 'archive', 'binaryData', 'c', 'config', 'cpp', 'css', 'docker', 'folder',
      'go', 'h', 'html', 'image', 'java', 'javaClass', 'javaScript', 'json', 'markdown',
      'python', 'rust', 'shell', 'sql', 'text', 'toml', 'typeScript', 'unknown', 'vue',
      'xml', 'yaml',
    ]))
    expect(manifest.assets.filter(asset => asset.dark === null).map(asset => asset.id).toSorted())
      .toEqual(['eclipse', 'gitignore', 'http', 'jenkins', 'vue'])

    for (const asset of manifest.assets) {
      for (const variant of [asset.light, asset.dark].filter((item): item is AssetVariant => item !== null)) {
        expect(variant.path).toMatch(
          /^src\/client\/assets\/jetbrains\/(?:expui\/(?:fileTypes|nodes)|language)\/[^/]+\.svg$/u,
        )
        expect(variant.source).toMatch(
          /^platform\/icons\/src\/(?:expui\/(?:fileTypes|nodes)|language)\/[^/]+\.svg$/u,
        )
        expect(variant.sha256).toMatch(/^[0-9a-f]{64}$/u)
        expect(variant.width).toBeGreaterThan(0)
        expect(variant.height).toBeGreaterThan(0)
        expect(variant.license).toBe('Apache-2.0')

        const path = resolve(packageRoot, variant.path)
        expect(packageRelative(path).startsWith('src/client/assets/jetbrains/')).toBe(true)
        expect(lstatSync(path).isSymbolicLink()).toBe(false)
        expect(relative(realpathSync(assetRoot), realpathSync(path))).not.toMatch(/^\.\.(?:\/|$)/u)

        const contents = readFileSync(path, 'utf8')
        expect(sha256(contents)).toBe(variant.sha256)
        expect(svgDimensions(contents)).toEqual({ width: variant.width, height: variant.height })
        const hasFileHeader = /^<!-- Copyright .*Apache 2\.0 license\./u.test(contents)
        expect(variant.licenseEvidence).toBe(hasFileHeader ? 'file-header' : 'repository-license')
        const withoutInternalPaintServers = contents.replace(/url\(\s*["']?#[^)]+\)/giu, '')
        expect(withoutInternalPaintServers)
          .not.toMatch(/<script\b|<!ENTITY\b|(?:href|xlink:href)=["']https?:|url\(/iu)
      }
    }
  })

  it('contains no unmanifested SVG and publishes both Apache and repository terms', () => {
    const manifest = readManifest()
    const manifestPaths = manifest.assets
      .flatMap(asset => [asset.light.path, asset.dark?.path])
      .filter((path): path is string => path !== undefined)
      .toSorted()
    expect(svgFiles(assetRoot).map(packageRelative).toSorted()).toEqual(manifestPaths)

    const notice = readFileSync(join(packageRoot, 'THIRD_PARTY_NOTICES'), 'utf8')
    expect(notice).toContain(manifest.source.commit)
    expect(notice).toContain('Apache License')
    expect(notice).toContain('JETBRAINS OPEN-SOURCE BUILD TERMS')
    expect(notice).toContain(manifest.source.repositoryTermsSha256)
  })
})
