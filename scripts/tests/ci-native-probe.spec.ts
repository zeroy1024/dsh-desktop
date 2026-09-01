import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findVendorPackageManifest,
  resolveNativePackage,
  type RequiredNativeModule,
} from '../ci-native-probe'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixtureVendor(): string {
  const vendor = mkdtempSync(join(tmpdir(), 'ci-native-probe-'))
  scratch.push(vendor)
  return vendor
}

function writePackage(path: string, manifest: Record<string, unknown>, entry = 'index.js'): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), `${JSON.stringify({ ...manifest, main: entry })}\n`)
  writeFileSync(join(path, entry), 'module.exports = {}\n')
}

function addProvider(vendor: string, provider: string, native: RequiredNativeModule): void {
  const encoded = `@deepseek-ai+dsh-${provider.slice('@deepseek-ai/dsh-'.length)}@fixture`
  const providerRoot = join(vendor, 'node_modules', '.pnpm', encoded, 'node_modules', ...provider.split('/'))
  writePackage(providerRoot, { name: provider, version: '0.0.0', dependencies: { [native]: '0.0.0' } })
  writePackage(join(providerRoot, 'node_modules', native), { name: native, version: '0.0.0' })
}

describe('vendor native package resolution', () => {
  it('resolves direct native dependencies from an isolated pnpm provider', () => {
    const vendor = fixtureVendor()
    addProvider(vendor, '@deepseek-ai/dsh-subprocess-local', 'node-pty')

    const resolution = resolveNativePackage(vendor, 'node-pty')
    expect(resolution.provider).toBe('@deepseek-ai/dsh-subprocess-local')
    expect(resolution.version).toBe('0.0.0')
    expect(resolution.entry.endsWith(join('node-pty', 'index.js'))).toBe(true)
    expect(existsSync(resolution.packageManifest)).toBe(true)
  })

  it('finds manifests in the virtual store but never treats an absent package as installed', () => {
    const vendor = fixtureVendor()
    addProvider(vendor, '@deepseek-ai/dsh-fs-local', 'koffi')

    expect(findVendorPackageManifest(vendor, '@deepseek-ai/dsh-fs-local')).toContain('package.json')
    expect(findVendorPackageManifest(vendor, '@deepseek-ai/dsh-attachment-local')).toBeNull()
  })

  it('reports a missing native package with an actionable closure error', () => {
    const vendor = fixtureVendor()
    const provider = '@deepseek-ai/dsh-attachment-local'
    const providerRoot = join(
      vendor,
      'node_modules',
      '.pnpm',
      '@deepseek-ai+dsh-attachment-local@fixture',
      'node_modules',
      '@deepseek-ai',
      'dsh-attachment-local',
    )
    writePackage(providerRoot, { name: provider, version: '0.0.0', dependencies: { sharp: '0.0.0' } })

    expect(() => resolveNativePackage(vendor, 'sharp')).toThrow(/无法从 vendor 闭包解析[\s\S]*pnpm install/u)
  })
})
