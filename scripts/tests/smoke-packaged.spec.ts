import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isValidPackagedSmokeReadyMarker,
  locatePackagedExecutable,
  packagedResourcesDir,
  parsePackagedSmokeOptions,
} from '../smoke-packaged'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'packaged-smoke-fixture-'))
  scratch.push(root)
  return root
}

function executable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o755)
}

describe('locatePackagedExecutable', () => {
  it('finds electron-builder output on macOS, Windows, and Linux', () => {
    const root = fixture()
    const mac = join(root, 'mac-arm64', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness')
    const win = join(root, 'win-unpacked', 'DeepSeek Harness.exe')
    const linux = join(root, 'linux-unpacked', 'deepseek-harness')
    executable(mac)
    executable(win)
    executable(linux)

    expect(locatePackagedExecutable(root, 'darwin')).toBe(mac)
    expect(locatePackagedExecutable(root, 'win32')).toBe(win)
    expect(locatePackagedExecutable(root, 'linux')).toBe(linux)
  })

  it('does not mistake Electron helper executables for the application', () => {
    const root = fixture()
    executable(join(root, 'linux-unpacked', 'chrome-sandbox'))

    expect(() => locatePackagedExecutable(root, 'linux')).toThrow(/未找到 linux/u)
  })

  it('resolves each platform resource directory from its executable', () => {
    expect(packagedResourcesDir('/tmp/App.app/Contents/MacOS/App', 'darwin'))
      .toBe('/tmp/App.app/Contents/Resources')
    expect(packagedResourcesDir('/tmp/win-unpacked/App.exe', 'win32'))
      .toBe('/tmp/win-unpacked/resources')
    expect(packagedResourcesDir('/tmp/linux-unpacked/app', 'linux'))
      .toBe('/tmp/linux-unpacked/resources')
  })
})

describe('packaged smoke options and marker', () => {
  it('requires an explicit release directory and parses a bounded timeout', () => {
    expect(() => parsePackagedSmokeOptions([])).toThrow(/release-dir/u)
    expect(parsePackagedSmokeOptions([
      '--',
      '--release-dir', 'apps/desktop/release',
      '--timeout-ms', '30000',
      '--keep-home',
    ])).toMatchObject({ timeoutMs: 30_000, keepHome: true, help: false })
  })

  it('accepts only a matching structured ready marker', () => {
    const root = fixture()
    const marker = join(root, '.dsh-desktop-ci-ready.json')
    writeFileSync(marker, JSON.stringify({ ready: true, platform: 'win32', pid: 123 }))
    expect(isValidPackagedSmokeReadyMarker(marker, 'win32')).toBe(true)
    expect(isValidPackagedSmokeReadyMarker(marker, 'linux')).toBe(false)
    writeFileSync(marker, '{}')
    expect(isValidPackagedSmokeReadyMarker(marker, 'win32')).toBe(false)
  })
})
