import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeDesktopProfile, STAMP_FILENAME } from '../src/desktop-profile'

const scratchDirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-profile-'))
  scratchDirs.push(dir)
  return dir
}

function pluginFixture(root: string, name: string): string {
  const dir = join(root, 'plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, private: true }, undefined, 2)}\n`)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs.length = 0
})

describe('materializeDesktopProfile', () => {
  it('创建 manifest、空 patch、插件符号链接和戳', () => {
    const root = scratch()
    const pluginDir = pluginFixture(root, '@dsh-desktop/hello-panel')
    const profileDir = materializeDesktopProfile({
      dshHome: join(root, 'home'),
      version: '0.1.0',
      plugins: [{ name: '@dsh-desktop/hello-panel', dir: pluginDir }],
    })

    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@dsh-desktop/hello-panel',
    ])
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(readlinkSync(join(profileDir, 'node_modules', '@dsh-desktop', 'hello-panel'))).toBe(pluginDir)
    const stamp = JSON.parse(readFileSync(join(profileDir, STAMP_FILENAME), 'utf8')) as { app: string }
    expect(stamp.app).toBe('deepseek-harness-desktop')
  })

  it('自愈：纠正指错目标的符号链接', () => {
    const root = scratch()
    const pluginDir = pluginFixture(root, '@dsh-desktop/hello-panel')
    const dshHome = join(root, 'home')
    const profileDir = materializeDesktopProfile({
      dshHome,
      version: '0.1.0',
      plugins: [{ name: '@dsh-desktop/hello-panel', dir: pluginDir }],
    })
    const link = join(profileDir, 'node_modules', '@dsh-desktop', 'hello-panel')
    const other = join(root, 'other')
    mkdirSync(other)
    rmSync(link, { force: true })
    symlinkSync(other, link, 'junction')
    materializeDesktopProfile({
      dshHome,
      version: '0.1.1',
      plugins: [{ name: '@dsh-desktop/hello-panel', dir: pluginDir }],
    })
    expect(readlinkSync(link)).toBe(pluginDir)
  })

  it('拒绝覆盖无戳的外来 profile', () => {
    const root = scratch()
    const profileDir = join(root, 'home', 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"user-owned"}\n')
    expect(() =>
      materializeDesktopProfile({
        dshHome: join(root, 'home'),
        version: '0.1.0',
        plugins: [],
      }),
    ).toThrow(/不是本 app 托管/)
  })
})
