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
import {
  defaultPatchesDir,
  defaultUpstreamDir,
  readPatchRegistry,
  registeredPatchPath,
  type PatchEntry,
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
    const detail = r.stderr?.toString().trim()
    throw new Error(
      `命令失败（exit ${String(r.status)}）：git ${args.join(' ')}${detail === '' ? '' : `\n${detail}`}`,
    )
  }
  return r.stdout.trim()
}

/** 在临时 Git index 上构造 diff，避免污染 worktree 的真实 index（同 sync-upstream）。 */
function withScratchIndex<T>(worktree: string, prefix: string, fn: (indexEnv: Record<string, string>) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), prefix))
  const indexEnv = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    runGit(worktree, ['read-tree', 'HEAD'], indexEnv)
    return fn(indexEnv)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** 只套登记补丁的标准 diff（与 sync-upstream 的 registeredPatchDiff 同构）。 */
function registeredDiff(worktree: string, patches: readonly PatchEntry[], patchesDir: string): string {
  return withScratchIndex(worktree, 'dsh-rehearse-registered-', (indexEnv) => {
    for (const entry of patches) {
      runGit(worktree, ['apply', '--cached', registeredPatchPath(entry.file, patchesDir)], indexEnv)
    }
    return runGit(worktree, ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], indexEnv)
  })
}

/** 工作树实际 diff（临时 index 纳入未跟踪文件；被 .gitignore 忽略的产物不进 index）。 */
function actualDiff(worktree: string): string {
  return withScratchIndex(worktree, 'dsh-rehearse-actual-', (indexEnv) => {
    runGit(worktree, ['add', '--all'], indexEnv)
    return runGit(worktree, ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], indexEnv)
  })
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
      runGit(worktree, ['apply', '--check', patchPath])
      runGit(worktree, ['apply', patchPath])
      console.log(`[rehearse] 已套用：${entry.file}`)
    }
    const actual = actualDiff(worktree)
    const expected = registeredDiff(worktree, entries, patchesDir)
    if (actual !== expected) {
      throw new Error('[rehearse] 套用后工作树 diff 与登记队列不一致，队列存在未登记改动')
    }
    console.log('[rehearse] 正序套用 = 登记队列 ✓')

    for (const entry of entries.toReversed()) {
      const patchPath = registeredPatchPath(entry.file, patchesDir)
      runGit(worktree, ['apply', '--reverse', '--check', patchPath])
      runGit(worktree, ['apply', '--reverse', patchPath])
      console.log(`[rehearse] 已撤销：${entry.file}`)
    }
    if (actualDiff(worktree) !== '') {
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