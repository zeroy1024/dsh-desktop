import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnCommandSync } from '../command'
import { rehearseQueue } from '../rehearse-queue'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** 合成 git 仓库：commit 一个 hello.txt，HEAD 停在它上面（含目录，补丁需 b/ 前缀）。 */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rehearse-repo-'))
  scratch.push(root)
  for (const step of [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.com'],
    ['config', 'user.name', 'Fixture'],
  ]) spawnCommandSync('git', step, { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, 'pkg'))
  writeFileSync(join(root, 'pkg', 'hello.txt'), 'hello\n')
  spawnCommandSync('git', ['add', 'pkg/hello.txt'], { cwd: root, stdio: 'pipe' })
  spawnCommandSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root, stdio: 'pipe' })
  return root
}

/** patches/{patches.yml,0001-test.patch}（改动 pkg/hello.txt）；补丁体由参数构造。 */
function patchDir(body: string, reason = 'fixture'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rehearse-patches-'))
  scratch.push(dir)
  writeFileSync(join(dir, '0001-test.patch'), body)
  writeFileSync(join(dir, 'patches.yml'), [
    'patches:',
    `  - file: 0001-test.patch`,
    `    reason: ${reason}`,
  ].join('\n'))
  return dir
}

function fixtureOptions(body: string): { upstreamDir: string; patchesDir: string } {
  const upstreamDir = gitRepo()
  return { upstreamDir, patchesDir: patchDir(body) }
}

const APPLY = [
  'diff --git a/pkg/hello.txt b/pkg/hello.txt',
  '--- a/pkg/hello.txt',
  '+++ b/pkg/hello.txt',
  '@@ -1 +1 @@',
  '-hello',
  '+hello patched',
  '',
].join('\n')

describe('rehearseQueue', () => {
  it('applies the registered queue and returns the tree to HEAD (happy path)', () => {
    const { upstreamDir, patchesDir } = fixtureOptions(APPLY)
    expect(() => rehearseQueue({ upstreamDir, patchesDir })).not.toThrow()
    // 演练只允许改动临时 worktree：真实仓库工作树必须保持干净
    const status = spawnCommandSync('git', ['status', '--porcelain'], { cwd: upstreamDir, encoding: 'utf8', stdio: 'pipe' })
    expect(status.stdout).toBe('')
  })

  it('fails when a registered patch cannot apply (tampered queue)', () => {
    const { upstreamDir, patchesDir } = fixtureOptions(APPLY)
    // 篡改上下文：前向 --check 即失败，防止「登记了但套不上的补丁」混进队列
    const tampered = [
      'diff --git a/pkg/hello.txt b/pkg/hello.txt',
      '--- a/pkg/hello.txt',
      '+++ b/pkg/hello.txt',
      '@@ -1 +1 @@',
      '-goodbye',
      '+hello patched',
      '',
    ].join('\n')
    writeFileSync(join(patchesDir, '0001-test.patch'), tampered)
    expect(() => rehearseQueue({ upstreamDir, patchesDir })).toThrow(/git apply/u)
    // 真实仓库工作树同样不能被演练污染
    const status = spawnCommandSync('git', ['status', '--porcelain'], { cwd: upstreamDir, encoding: 'utf8', stdio: 'pipe' })
    expect(status.stdout).toBe('')
  })

  it('leaves no worktree registration behind after a successful run', () => {
    const { upstreamDir, patchesDir } = fixtureOptions(APPLY)
    rehearseQueue({ upstreamDir, patchesDir })
    const list = spawnCommandSync('git', ['worktree', 'list'], { cwd: upstreamDir, encoding: 'utf8', stdio: 'pipe' })
    const entries = list.stdout.trim().split('\n').filter(line => line !== '')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(upstreamDir)
  })
})
