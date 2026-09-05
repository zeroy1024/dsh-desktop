/** Compare and migrate registered patch queues without resetting upstream files. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCommandSync } from './command'
import { readPatchRegistry, registeredPatchPath, type PatchEntry } from './sync-fingerprint'

function gitBytes(upstreamDir: string, args: string[], env?: Record<string, string>): Buffer {
  const result = spawnCommandSync('git', args, {
    cwd: upstreamDir, stdio: 'pipe', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw result.error ?? new Error(`[patches] git ${args.join(' ')} failed: ${result.stderr?.toString().trim() ?? ''}`)
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
}

function git(upstreamDir: string, args: string[], env?: Record<string, string>): string {
  return gitBytes(upstreamDir, args, env).toString('utf8')
}

function withIndex(upstreamDir: string, populate: (env: Record<string, string>) => void): string {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-queue-index-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    git(upstreamDir, ['read-tree', 'HEAD'], env)
    populate(env)
    return git(upstreamDir, ['write-tree'], env).trim()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Git trees compare paths, modes and bytes, including files added by patches. */
export function patchQueueTree(upstreamDir: string, patches: readonly PatchEntry[], patchesDir: string): string {
  return withIndex(upstreamDir, env => {
    for (const entry of patches) {
      git(upstreamDir, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--cached', registeredPatchPath(entry.file, patchesDir)], env)
    }
  })
}

export function upstreamWorktreeTree(upstreamDir: string): string {
  return withIndex(upstreamDir, env => { git(upstreamDir, ['add', '--all'], env) })
}

/**
 * Replace an exact old registered queue with an already validated new queue.
 * One git apply performs the complete transition. Unknown/staged edits cause
 * an error before any worktree mutation; no checkout/reset/clean is used.
 */
export function replacePatchQueue(upstreamDir: string, oldDir: string, nextDir: string): void {
  git(upstreamDir, ['diff', '--cached', '--quiet', 'HEAD'])
  const nextTree = patchQueueTree(upstreamDir, readPatchRegistry(nextDir), nextDir)
  const actualTree = upstreamWorktreeTree(upstreamDir)
  if (actualTree === nextTree) return
  const oldTree = patchQueueTree(upstreamDir, readPatchRegistry(oldDir), oldDir)
  if (actualTree !== oldTree) {
    throw new Error('[patches] upstream 不等于指定的旧登记队列，拒绝覆盖未登记修改')
  }
  // Git may emit non-UTF-8 text hunks even with --binary. Never decode a patch.
  const delta = gitBytes(upstreamDir, [
    'diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', oldTree, nextTree,
  ])
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-queue-transition-'))
  try {
    const patch = join(scratch, 'transition.patch')
    writeFileSync(patch, delta)
    git(upstreamDir, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--check', patch])
    git(upstreamDir, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', patch])
    if (upstreamWorktreeTree(upstreamDir) !== nextTree) {
      throw new Error('[patches] 迁移后的工作树与新登记队列不符')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
