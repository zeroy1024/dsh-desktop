/**
 * sync-upstream.ts — 上游同步链路（幂等，可重复执行）
 *
 * 步骤：
 *   1. 校验 Node 版本与 upstream 子模块存在
 *   2. 套用 patches/（以 patches/patches.yml 为准，git apply；已套用则跳过）
 *   3. upstream 内 pnpm install --frozen-lockfile
 *   4. upstream 内 pnpm build
 *   5. pnpm pack 关键包到 vendor/（pack 会把上游内部 workspace: 协议解析为实体版本号，
 *      我们的包因此可以跨 workspace 消费上游构建产物）
 *   6. 把 CLI tarball 安装成 vendor/dsh-cli/（独立 workspace + pnpm install --prod）
 *
 *      为什么需要第 6 步：monorepo 里直接跑 apps/cli/lib/bin.js 时，Cordis loader
 *      动态 import 的 @deepseek-ai/dsh-* 包无法从自身位置解析（它们只存在于
 *      apps/cli/node_modules 与 pnpm store，源码形态靠 tsx 的 tsconfig paths 解析）。
 *      安装成完整 node_modules 布局（等同 npx @deepseek-ai/dsh）后才能正常启动，
 *      这也是 P4 打包时分发的形态。
 *
 * 用法：
 *   pnpm sync:upstream                   全量
 *   pnpm sync:upstream -- --skip-build   跳过构建与打包（仅补丁+安装）
 *   pnpm sync:upstream -- --skip-pack    跳过打包与 CLI 安装
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamDir = join(rootDir, 'upstream')
const patchesDir = join(rootDir, 'patches')
const vendorDir = join(rootDir, 'vendor')

/** 需要 pack 到 vendor/ 的上游包（相对 upstream/ 的目录） */
const PACK_TARGETS = ['apps/cli', 'apps/web']

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const skipPack = args.includes('--skip-pack')
const effectiveSkipPack = skipPack || skipBuild
const unknownArgs = args.filter((arg) => arg !== '--skip-build' && arg !== '--skip-pack')
if (unknownArgs.length > 0) throw new Error(`未知参数：${unknownArgs.join(', ')}`)

function run(cmd: string, cmdArgs: string[], cwd: string, env?: Record<string, string>): void {
  console.log(`\n$ (cd ${cwd} && ${cmd} ${cmdArgs.join(' ')})`)
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) {
    throw new Error(`命令失败（exit ${r.status}）：${cmd} ${cmdArgs.join(' ')}`)
  }
}

function tryRun(cmd: string, cmdArgs: string[], cwd: string): boolean {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'pipe', env: process.env })
  return r.status === 0
}

function capture(
  cmd: string,
  cmdArgs: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(`命令失败（exit ${r.status}）：${cmd} ${cmdArgs.join(' ')}`)
  }
  return r.stdout.trim()
}

/** 记录上次完整同步的 commit + 补丁队列指纹（vendor/ 下，随 vendor 一起重建）。 */
const commitMarkerPath = join(vendorDir, '.upstream-commit')

interface PatchEntry {
  file: string
  reason: string
  upstream?: string
}

function readPatchRegistry(): PatchEntry[] {
  const registryPath = join(patchesDir, 'patches.yml')
  const registry = yaml.load(readFileSync(registryPath, 'utf8')) as { patches?: unknown } | null
  if (registry?.patches === undefined) return []
  if (!Array.isArray(registry.patches)) throw new Error('[patches] patches.yml 的 patches 必须是数组')
  const seen = new Set<string>()
  return registry.patches.map((value, index) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`[patches] 第 ${index + 1} 项必须是对象`)
    }
    const entry = value as Partial<PatchEntry>
    if (typeof entry.file !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`[patches] 第 ${index + 1} 项必须提供 file 与非空 reason`)
    }
    if (seen.has(entry.file)) throw new Error(`[patches] 重复登记：${entry.file}`)
    seen.add(entry.file)
    registeredPatchPath(entry.file)
    return {
      file: entry.file,
      reason: entry.reason,
      ...(typeof entry.upstream === 'string' ? { upstream: entry.upstream } : {}),
    }
  })
}

function registeredPatchPath(file: string): string {
  const path = resolve(patchesDir, file)
  if (!path.startsWith(`${patchesDir}${sep}`) || !file.endsWith('.patch')) {
    throw new Error(`[patches] 非法补丁路径：${file}`)
  }
  return path
}

function syncFingerprint(patches: readonly PatchEntry[]): string {
  const hash = createHash('sha256')
  hash.update(capture('git', ['rev-parse', 'HEAD'], upstreamDir))
  hash.update('\0')
  hash.update(readFileSync(join(patchesDir, 'patches.yml')))
  for (const entry of patches) {
    const patchPath = registeredPatchPath(entry.file)
    if (!existsSync(patchPath)) throw new Error(`[patches] 登记的文件不存在：${entry.file}`)
    hash.update('\0')
    hash.update(entry.file)
    hash.update('\0')
    hash.update(readFileSync(patchPath))
  }
  return `${capture('git', ['rev-parse', 'HEAD'], upstreamDir)} ${hash.digest('hex')}`
}

/**
 * 上游 commit 变化后必须先 `pnpm run clean`：不同版本的 lib/ 构建残留会混进
 * tsdown 打包导致 MISSING_EXPORT 之类错误。首次同步（有 node_modules 却无标记）
 * 同样清理一次。
 */
function cleanIfInputsChanged(fingerprint: string): void {
  const head = fingerprint.split(' ')[0]!
  const last = existsSync(commitMarkerPath) ? readFileSync(commitMarkerPath, 'utf8').trim() : null
  if (last === fingerprint) return
  if (existsSync(join(upstreamDir, 'node_modules'))) {
    console.log(`\n[clean] 上游 commit ${last ?? '未知'} → ${head}，清理旧构建产物`)
    // macOS 的 .DS_Store 会让上游 clean 脚本把「只剩 .DS_Store 的目录」误判为未知目录而拒绝清理
    for (const junk of globSync('packages/**/.DS_Store', { cwd: upstreamDir })) {
      rmSync(join(upstreamDir, junk), { force: true })
    }
    run('pnpm', ['run', 'clean'], upstreamDir, { CI: 'true' })
  }
}

function markFullySynced(fingerprint: string): void {
  if (skipBuild || effectiveSkipPack) {
    console.log('\n[sync] 部分流程未更新完整同步标记')
    return
  }
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(commitMarkerPath, `${fingerprint}\n`)
}

function checkEnvironment(): void {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node 版本过低：${process.versions.node}，上游要求 ^22.19.0 || >=24.0.0`)
  }
  if (major < 24) {
    console.warn(`警告：当前 Node ${process.versions.node}，建议使用 Node 24（上游依赖 node:sqlite）`)
  }
  if (!existsSync(join(upstreamDir, 'package.json'))) {
    throw new Error('upstream/ 子模块未初始化，请先执行：git submodule update --init')
  }
}

function applyPatches(patches: readonly PatchEntry[]): void {
  if (patches.length === 0) {
    console.log('\n[patches] 无登记的补丁，跳过')
    return
  }
  for (const entry of patches) {
    const patchPath = registeredPatchPath(entry.file)
    if (!existsSync(patchPath)) {
      throw new Error(`[patches] 登记的文件不存在：${entry.file}`)
    }
    const alreadyApplied = tryRun('git', ['apply', '--reverse', '--check', patchPath], upstreamDir)
    if (alreadyApplied) {
      console.log(`[patches] 已套用，跳过：${entry.file}`)
      continue
    }
    run('git', ['apply', '--check', patchPath], upstreamDir)
    run('git', ['apply', patchPath], upstreamDir)
    console.log(`[patches] 已套用：${entry.file}（${entry.reason}）`)
  }
}

/** 用临时 Git index 构造“只套登记补丁”的标准 diff，拒绝 upstream 里的私改。 */
function verifyOnlyRegisteredPatches(patches: readonly PatchEntry[]): void {
  const untracked = capture(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    upstreamDir,
  ).split('\n').filter((line) => line.startsWith('?? '))
  if (untracked.length > 0) {
    throw new Error(`[patches] upstream 存在未登记文件：\n${untracked.join('\n')}`)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-patch-index-'))
  const indexPath = join(scratch, 'index')
  const indexEnv = { GIT_INDEX_FILE: indexPath }
  try {
    capture('git', ['read-tree', 'HEAD'], upstreamDir, indexEnv)
    for (const entry of patches) {
      capture('git', ['apply', '--cached', registeredPatchPath(entry.file)], upstreamDir, indexEnv)
    }
    const expected = capture('git', ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], upstreamDir, indexEnv)
    const actual = capture('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], upstreamDir)
    if (actual !== expected) {
      throw new Error(
        '[patches] upstream 工作树包含未登记修改，拒绝继续。请把变更制作成 patches/*.patch，或先恢复子模块。',
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function installAndBuild(): void {
  // CI=true：跳过上游 postinstall 里的 lefthook git-hooks 安装（contributor 工具，
  // 在 submodule 里会因 git worktree 配置冲突而失败；其余安装脚本不受影响）
  run('pnpm', ['install', '--frozen-lockfile'], upstreamDir, { CI: 'true' })
  if (!skipBuild) {
    run('pnpm', ['build'], upstreamDir)
  }
}

function packTargets(): void {
  if (effectiveSkipPack) return
  mkdirSync(vendorDir, { recursive: true })
  for (const old of readdirSync(vendorDir).filter((f) => f.endsWith('.tgz'))) {
    rmSync(join(vendorDir, old))
  }
  for (const target of PACK_TARGETS) {
    run('pnpm', ['pack', '--pack-destination', vendorDir], join(upstreamDir, target))
  }
  console.log(`\n[vendor] 已生成：${readdirSync(vendorDir).join(', ')}`)
}

/** 把 CLI tarball 安装成 vendor/dsh-cli/（完整 node_modules 布局，桌面运行时实际使用）。 */
function installCli(): void {
  if (effectiveSkipPack) return
  const cliInstallDir = join(vendorDir, 'dsh-cli')
  mkdirSync(cliInstallDir, { recursive: true })
  const cliManifest = JSON.parse(readFileSync(join(upstreamDir, 'apps/cli/package.json'), 'utf8')) as {
    version: string
  }
  writeFileSync(
    join(cliInstallDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-desktop-cli-install',
        private: true,
        dependencies: { '@deepseek-ai/dsh': `file:../deepseek-ai-dsh-${cliManifest.version}.tgz` },
      },
      null,
      2,
    )}\n`,
  )
  // 独立 workspace 根：避免被本仓库主 workspace 吞并。
  // allowBuilds：pnpm 11 默认禁止依赖安装脚本且将被禁视为失败；
  // koffi/node-pty 的原生预编译与 subprocess-local 的 spawn helper 是运行时必需。
  writeFileSync(
    join(cliInstallDir, 'pnpm-workspace.yaml'),
    [
      'packages: []',
      'allowBuilds:',
      "  '@deepseek-ai/dsh-subprocess-local': true",
      "  '@google/genai': true",
      '  koffi: true',
      '  node-pty: true',
      '  protobufjs: true',
      '',
    ].join('\n'),
  )
  const lockfilePath = join(cliInstallDir, 'pnpm-lock.yaml')
  const installArgs = existsSync(lockfilePath)
    ? ['install', '--prod', '--frozen-lockfile']
    : ['install', '--prod']
  run('pnpm', installArgs, cliInstallDir, { CI: 'true' })
}

checkEnvironment()
const patches = readPatchRegistry()
applyPatches(patches)
verifyOnlyRegisteredPatches(patches)
const fingerprint = syncFingerprint(patches)
cleanIfInputsChanged(fingerprint)
installAndBuild()
packTargets()
installCli()
markFullySynced(fingerprint)
console.log('\nsync-upstream 完成 ✓')
