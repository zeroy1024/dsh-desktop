/**
 * rehearse-queue.ts — 补丁队列逆转演练
 *
 * patches.yml 里的撤补丁纪律（如撤 0005 须连撤 0008/0009）此前只靠人工核对。
 * 本脚本在一份 scratch worktree 上（git worktree add，绝不触碰真实 upstream
 * 工作树）：正序套用全部登记补丁 → 校验工作树 diff 与登记队列一致（同
 * sync-upstream 的 verifyOnlyRegisteredPatches）→ 逆序反向撤销 → 校验工作树
 * 回到 HEAD。
 *
 * 用法：pnpm rehearse:queue
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCommandSync } from './command'
import { patchQueueTree, upstreamWorktreeTree } from './patch-queue'
import {
  defaultPatchesDir,
  defaultUpstreamDir,
  readPatchRegistry,
  registeredPatchPath,
} from './sync-fingerprint'

export interface RehearseOptions {
  /** upstream 子模块目录（缺省仓库 upstream/）。 */
  upstreamDir?: string
  /** patches/ 目录（缺省仓库 patches/）。 */
  patchesDir?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runGit(worktree: string, args: string[], env?: Record<string, string>): string {
  const r = spawnCommandSync('git', args, {
    cwd: worktree,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) {
    const detail = [r.stderr, r.stdout].map(output => output?.toString().trim() ?? '').filter(Boolean).join('\n')
    throw new Error(
      `命令失败（exit ${String(r.status)}）：git ${args.join(' ')}${detail === '' ? '' : `\n${detail}`}`,
    )
  }
  return r.stdout.trim()
}

export function rehearseQueue(options: RehearseOptions = {}): void {
  const upstreamDir = resolve(options.upstreamDir ?? defaultUpstreamDir)
  const patchesDir = resolve(options.patchesDir ?? defaultPatchesDir)
  if (!existsSync(join(upstreamDir, '.git'))) {
    throw new Error('rehearse-queue: upstream 子模块未初始化（缺 .git），先执行 git submodule update --init')
  }
  const entries = readPatchRegistry(patchesDir)
  if (entries.length === 0) {
    console.log('[rehearse] patches.yml 无登记补丁，跳过')
    return
  }
  // 提前校验登记文件存在，避免建好 worktree 才发现缺失
  for (const entry of entries) {
    if (!existsSync(registeredPatchPath(entry.file, patchesDir))) {
      throw new Error(`[patches] 登记的文件不存在：${entry.file}`)
    }
  }

  const worktree = mkdtempSync(join(tmpdir(), 'dsh-rehearse-'))
  try {
    // --detach：upstream HEAD 通常已在主工作树检出，非 detached 会被拒绝
    runGit(upstreamDir, ['worktree', 'add', '--detach', worktree, 'HEAD'])
  } catch (error) {
    rmSync(worktree, { recursive: true, force: true })
    throw new Error(`[rehearse] 创建 scratch worktree 失败：${messageOf(error)}`, { cause: error })
  }
  try {
    console.log(`[rehearse] scratch worktree：${worktree}`)
    for (const entry of entries) {
      const patchPath = registeredPatchPath(entry.file, patchesDir)
      runGit(worktree, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--check', patchPath])
      runGit(worktree, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', patchPath])
      console.log(`[rehearse] 已套用：${entry.file}`)
    }
    const actual = upstreamWorktreeTree(worktree)
    const expected = patchQueueTree(worktree, entries, patchesDir)
    if (actual !== expected) {
      throw new Error('[rehearse] 套用后工作树 diff 与登记队列不一致，队列存在未登记改动')
    }
    // Blank unified-diff context lines are syntax, so .gitattributes excludes
    // patch-file EOL warnings. Validate the resulting source, including added
    // files, where whitespace mistakes can actually affect maintained code.
    runGit(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--check', 'HEAD', expected])
    console.log('[rehearse] 正序套用 = 登记队列 ✓')

    for (const entry of entries.toReversed()) {
      const patchPath = registeredPatchPath(entry.file, patchesDir)
      runGit(worktree, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--reverse', '--check', patchPath])
      runGit(worktree, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', '--reverse', patchPath])
      console.log(`[rehearse] 已撤销：${entry.file}`)
    }
    if (upstreamWorktreeTree(worktree) !== runGit(worktree, ['rev-parse', 'HEAD^{tree}'])) {
      throw new Error('[rehearse] 逆序撤销后工作树未回到 HEAD，队列存在隐藏依赖或残留改动')
    }
    console.log('[rehearse] 逆序撤销 = HEAD ✓')
  } finally {
    // 无论如何都要清理 scratch worktree；失败则兜底删目录 + prune 注册表
    const removed = spawnCommandSync(
      'git',
      ['-C', upstreamDir, 'worktree', 'remove', '--force', worktree],
      { stdio: 'pipe' },
    )
    if (removed.status !== 0) {
      rmSync(worktree, { recursive: true, force: true })
      spawnCommandSync('git', ['-C', upstreamDir, 'worktree', 'prune'], { stdio: 'pipe' })
    }
  }
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    rehearseQueue()
    console.log('\nrehearse-queue 完成 ✓')
  } catch (error) {
    console.error(`[rehearse] ${messageOf(error)}`)
    process.exitCode = 1
  }
}
