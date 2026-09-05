import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { spawnCommandSync } from '../command'
import { patchQueueTree, replacePatchQueue, upstreamWorktreeTree } from '../patch-queue'
import { readPatchRegistry } from '../sync-fingerprint'

const scratch: string[] = []
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-queue-test-'))
  scratch.push(dir)
  return dir
}
function git(dir: string, ...args: string[]): string {
  const result = spawnCommandSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
function queue(value: string, extra: string): string {
  const dir = temp()
  writeFileSync(join(dir, 'patches.yml'), 'patches:\n  - file: test.patch\n    reason: fixture\n')
  writeFileSync(join(dir, 'test.patch'), [
    'diff --git a/base.txt b/base.txt', '--- a/base.txt', '+++ b/base.txt', '@@ -1 +1 @@', '-base', `+${value}`,
    `diff --git a/${extra}.txt b/${extra}.txt`, 'new file mode 100644', '--- /dev/null', `+++ b/${extra}.txt`,
    '@@ -0,0 +1 @@', `+${extra}`, '',
  ].join('\n'))
  return dir
}
function fixture(): { upstream: string; old: string; next: string } {
  const upstream = temp()
  git(upstream, 'init', '-q')
  git(upstream, 'config', 'user.email', 'fixture@example.invalid')
  git(upstream, 'config', 'user.name', 'Fixture')
  // Mirror upstream's .gitattributes contract (* text=auto eol=lf): attribute
  // rules beat core.autocrlf at git apply write-out, so fixture worktrees stay
  // LF even on hosts with system-level autocrlf=true (Windows CI runners).
  writeFileSync(join(upstream, '.gitattributes'), '* text=auto eol=lf\n')
  writeFileSync(join(upstream, 'base.txt'), 'base\n')
  git(upstream, 'add', '--all')
  git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
  const old = queue('old', 'old-added')
  const next = queue('next', 'next-added')
  git(upstream, 'apply', join(old, 'test.patch'))
  return { upstream, old, next }
}

it('migrates changed, added and removed files as one delta and is repeatable', () => {
  const { upstream, old, next } = fixture()
  const originalIndex = git(upstream, 'write-tree')
  replacePatchQueue(upstream, old, next)
  expect(readFileSync(join(upstream, 'base.txt'), 'utf8')).toBe('next\n')
  expect(existsSync(join(upstream, 'old-added.txt'))).toBe(false)
  expect(readFileSync(join(upstream, 'next-added.txt'), 'utf8')).toBe('next-added\n')
  expect(upstreamWorktreeTree(upstream)).toBe(patchQueueTree(upstream, readPatchRegistry(next), next))
  expect(git(upstream, 'write-tree')).toBe(originalIndex)
  expect(() => replacePatchQueue(upstream, old, next)).not.toThrow()
})

it.each(['base.txt', 'unregistered.txt'])('refuses unknown edits to %s without changing the worktree', file => {
  const { upstream, old, next } = fixture()
  writeFileSync(join(upstream, file), 'user content\n')
  const before = upstreamWorktreeTree(upstream)
  expect(() => replacePatchQueue(upstream, old, next)).toThrow(/未登记修改/u)
  expect(upstreamWorktreeTree(upstream)).toBe(before)
})

it('validates the next queue before touching an applied old queue', () => {
  const { upstream, old, next } = fixture()
  const before = upstreamWorktreeTree(upstream)
  const path = join(next, 'test.patch')
  writeFileSync(path, readFileSync(path, 'utf8').replace('-base\n', '-wrong base\n'))
  expect(() => replacePatchQueue(upstream, old, next)).toThrow(/git .*apply/u)
  expect(upstreamWorktreeTree(upstream)).toBe(before)
})

it('preserves trailing whitespace in the transition patch', () => {
  const { upstream, old, next } = fixture()
  const path = join(next, 'test.patch')
  writeFileSync(path, readFileSync(path, 'utf8').replace('+next-added\n', '+next-added   \n'))
  replacePatchQueue(upstream, old, next)
  expect(readFileSync(join(upstream, 'next-added.txt'), 'utf8')).toBe('next-added   \n')
})

it('preserves registered whitespace even when git apply.whitespace is configured to fix it', () => {
  const { upstream, old, next } = fixture()
  git(upstream, 'config', 'apply.whitespace', 'fix')
  const path = join(next, 'test.patch')
  writeFileSync(path, readFileSync(path, 'utf8').replace('+next-added\n', '+next-added   \n'))
  replacePatchQueue(upstream, old, next)
  expect(readFileSync(join(upstream, 'next-added.txt'), 'utf8')).toBe('next-added   \n')
})

it.each([
  { kind: 'binary', baseBytes: [0, 1, 2, 255], oldBytes: [0, 3, 4, 255], nextBytes: [0, 5, 6, 255] },
  // Git treats NUL-free Latin-1 as text; --binary alone does not base85-encode it.
  { kind: 'non-UTF-8 text', baseBytes: [97, 10], oldBytes: [98, 10], nextBytes: [99, 255, 10] },
])('migrates $kind bytes without invoking configured text conversion', ({ baseBytes, oldBytes, nextBytes }) => {
  const upstream = temp()
  git(upstream, 'init', '-q')
  git(upstream, 'config', 'user.email', 'fixture@example.invalid')
  git(upstream, 'config', 'user.name', 'Fixture')
  const asset = join(upstream, 'asset.bin')
  const base = Buffer.from(baseBytes)
  writeFileSync(asset, base)
  // The leading rule mirrors upstream's checkout contract so apply write-out
  // keeps NUL-free text bytes LF regardless of host autocrlf; NUL-bearing
  // blobs still take the binary path.
  writeFileSync(join(upstream, '.gitattributes'), '* text=auto eol=lf\n*.bin diff=fixture\n')
  git(upstream, 'add', '--all')
  git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'binary fixture')
  const binaryQueue = (bytes: Buffer): string => {
    const dir = temp()
    writeFileSync(asset, bytes)
    writeFileSync(join(dir, 'patches.yml'), 'patches:\n  - file: binary.patch\n    reason: fixture\n')
    const diff = spawnCommandSync('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], {
      cwd: upstream, stdio: 'pipe',
    })
    if (diff.status !== 0) throw new Error(diff.stderr.toString())
    // Binary literal blocks require their terminating blank line verbatim.
    writeFileSync(join(dir, 'binary.patch'), diff.stdout)
    return dir
  }
  const old = binaryQueue(Buffer.from(oldBytes))
  const expected = Buffer.from(nextBytes)
  const next = binaryQueue(expected)
  writeFileSync(asset, base)
  git(upstream, 'apply', join(old, 'binary.patch'))
  const helper = join(temp(), 'textconv.mjs')
  const marker = join(temp(), 'textconv-ran')
  writeFileSync(helper, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called'); process.stdout.write('same projection\\n')\n`)
  git(upstream, 'config', 'diff.fixture.textconv', `"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`)
  const index = git(upstream, 'write-tree')

  replacePatchQueue(upstream, old, next)

  expect(readFileSync(asset)).toEqual(expected)
  expect(existsSync(marker)).toBe(false)
  expect(git(upstream, 'write-tree')).toBe(index)
})

it('preserves a new file without a final newline', () => {
  const { upstream, old, next } = fixture()
  const path = join(next, 'test.patch')
  writeFileSync(path, readFileSync(path, 'utf8').replace('+next-added\n', '+next-added\n\\ No newline at end of file\n'))
  replacePatchQueue(upstream, old, next)
  expect(readFileSync(join(upstream, 'next-added.txt'), 'utf8')).toBe('next-added')
})

it.skipIf(process.platform === 'win32')('preserves an executable mode change without staging it', () => {
  const { upstream, old, next } = fixture()
  const path = join(next, 'test.patch')
  writeFileSync(path, readFileSync(path, 'utf8').replace('diff --git a/base.txt b/base.txt\n', 'diff --git a/base.txt b/base.txt\nold mode 100644\nnew mode 100755\n'))
  const index = git(upstream, 'write-tree')
  replacePatchQueue(upstream, old, next)
  expect(statSync(join(upstream, 'base.txt')).mode & 0o111).toBe(0o111)
  expect(git(upstream, 'write-tree')).toBe(index)
})

it('refuses staged changes without rewriting the real index', () => {
  const { upstream, old, next } = fixture()
  git(upstream, 'add', 'base.txt')
  const index = git(upstream, 'write-tree')
  const before = upstreamWorktreeTree(upstream)
  expect(() => replacePatchQueue(upstream, old, next)).toThrow(/--cached/u)
  expect(git(upstream, 'write-tree')).toBe(index)
  expect(upstreamWorktreeTree(upstream)).toBe(before)
})
