import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnCommandSync } from '../command'
import { readPatchRegistry, syncFingerprint } from '../sync-fingerprint'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** 极小合成 git 仓库：两个提交，HEAD 为 second.txt。 */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fingerprint-fixture-'))
  scratch.push(root)
  for (const step of [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.com'],
    ['config', 'user.name', 'Fixture'],
    ['commit', '-q', '--allow-empty', '-m', 'first'],
  ]) spawnCommandSync('git', step, { cwd: root, stdio: 'pipe' })
  writeFileSync(join(root, 'second.txt'), 'second')
  spawnCommandSync('git', ['add', 'second.txt'], { cwd: root, stdio: 'pipe' })
  spawnCommandSync('git', ['commit', '-q', '-m', 'second'], { cwd: root, stdio: 'pipe' })
  return root
}

/** patches/{patches.yml,0001-test.patch} 与一个改动 hello.txt 的补丁；返回 patches 目录。 */
function patchDir(gitRoot: string, patchBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fingerprint-patches-'))
  scratch.push(dir)
  writeFileSync(join(dir, '0001-test.patch'), patchBody)
  writeFileSync(join(dir, 'patches.yml'), [
    'patches:',
    '  - file: 0001-test.patch',
    '    reason: fixture',
  ].join('\n'))
  // syncFingerprint 校验登记文件确实存在；本测试不需要真实套用
  const tracked = join(gitRoot, 'hello.txt')
  if (!existsSync(tracked)) writeFileSync(tracked, 'hello')
  return dir
}

const BODY_A = [
  'diff --git a/hello.txt b/hello.txt',
  '--- a/hello.txt',
  '+++ b/hello.txt',
  '@@ -1 +1 @@',
  '-hello',
  '+hello a',
].join('\n')
const BODY_B = BODY_A.replace('+hello a', '+hello b')

describe('syncFingerprint', () => {
  it('is stable for identical inputs and formatted `<commit> <sha256-hex>`', () => {
    const gitRoot = gitRepo()
    const patches = patchDir(gitRoot, BODY_A)
    const first = syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches })
    const second = syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches })
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{40} [0-9a-f]{64}$/u)
    const head = spawnCommandSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', stdio: 'pipe' })
    expect(first.split(' ')[0]).toBe(head.stdout.trim())
  })

  it('changes when a registered patch file changes', () => {
    const gitRoot = gitRepo()
    const patches = patchDir(gitRoot, BODY_A)
    const before = syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches })
    writeFileSync(join(patches, '0001-test.patch'), BODY_B)
    const after = syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches })
    expect(after).not.toBe(before)
  })

  it('changes when patches.yml changes', () => {
    const gitRoot = gitRepo()
    const patches = patchDir(gitRoot, BODY_A)
    const before = syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches })
    writeFileSync(join(patches, 'patches.yml'), [
      'patches:',
      '  - file: 0001-test.patch',
      '    reason: changed',
    ].join('\n'))
    expect(syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches }))
      .not.toBe(before)
  })

  it('throws when a registered patch file is missing', () => {
    const gitRoot = gitRepo()
    const patches = patchDir(gitRoot, BODY_A)
    rmSync(join(patches, '0001-test.patch'))
    expect(() => syncFingerprint(readPatchRegistry(patches), { upstreamDir: gitRoot, patchesDir: patches }))
      .toThrow(/登记的文件不存在/u)
  })
})
