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
import { spawnCommandSync, spawnPnpmSync } from './command'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamDir = join(rootDir, 'upstream')
const patchesDir = join(rootDir, 'patches')
const vendorDir = join(rootDir, 'vendor')

/** 无论补丁内容如何都要分发的基础包（相对 upstream/ 的目录）。 */
const BASE_PACK_TARGETS = ['apps/cli', 'apps/web']

/**
 * 桌面内置 Host 插件的编译期 API 面。
 *
 * packages/plugins 不得 import upstream/src，也不能依赖开发机上 ~/.dsh 的
 * profile symlink；这些 tarball 让全新 checkout 的 pnpm install 拿到与当前
 * submodule pin 完全一致的公开包。运行时仍由 desktop profile 组合同一套
 * dsh 安装闭包，避免出现两份 Cordis/service identity。
 */
const PLUGIN_API_PACK_TARGETS = [
  'vendor/cordis',
  'vendor/schemastery',
  'packages/credentials/credentials',
  'packages/llm/llm',
  'packages/settings/settings',
  'packages/util/launch-environment',
  'packages/web/web',
] as const

interface PackedPackage {
  target: string
  name: string
  version: string
  tarball: string
  specifier: string
}

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const skipPack = args.includes('--skip-pack')
const effectiveSkipPack = skipPack || skipBuild
const unknownArgs = args.filter((arg) => !['--', '--skip-build', '--skip-pack'].includes(arg))
if (unknownArgs.length > 0) throw new Error(`未知参数：${unknownArgs.join(', ')}`)

function run(cmd: string, cmdArgs: string[], cwd: string, env?: Record<string, string>): void {
  console.log(`\n$ (cd ${cwd} && ${cmd} ${cmdArgs.join(' ')})`)
  const options = { cwd, stdio: 'inherit' as const, env: { ...process.env, ...env } }
  const r = cmd === 'pnpm'
    ? spawnPnpmSync(cmdArgs, options)
    : spawnCommandSync(cmd, cmdArgs, options)
  if (r.status !== 0) {
    throw new Error(`命令失败（exit ${r.status}）：${cmd} ${cmdArgs.join(' ')}`)
  }
}

function tryRun(cmd: string, cmdArgs: string[], cwd: string): boolean {
  const r = spawnCommandSync(cmd, cmdArgs, { cwd, stdio: 'pipe', env: process.env })
  return r.status === 0
}

function capture(
  cmd: string,
  cmdArgs: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  const r = spawnCommandSync(cmd, cmdArgs, {
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

/** 找到一个补丁文件所属的最近 workspace package；根配置/文档返回 null。 */
function packageTargetForFile(file: string): string | null {
  let cursor = dirname(file)
  while (cursor !== '.' && cursor !== sep) {
    if (existsSync(join(upstreamDir, cursor, 'package.json'))) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return null
}

/** 基础分发包 + 所有登记补丁触及的 package，确保 patch 真正进入运行时闭包。 */
function packTargetsFor(patches: readonly PatchEntry[]): string[] {
  const targets = new Set<string>([...BASE_PACK_TARGETS, ...PLUGIN_API_PACK_TARGETS])
  for (const entry of patches) {
    const numstat = capture('git', ['apply', '--numstat', registeredPatchPath(entry.file)], upstreamDir)
    for (const row of numstat.split('\n')) {
      if (row === '') continue
      const file = row.split('\t').at(-1)
      if (file === undefined || file === '') continue
      const target = packageTargetForFile(file)
      if (target !== null) targets.add(target)
    }
  }
  const extras = [...targets].filter(target => !BASE_PACK_TARGETS.includes(target)).toSorted()
  return [...BASE_PACK_TARGETS, ...extras]
}

function packedPackage(target: string): PackedPackage {
  const manifest = JSON.parse(readFileSync(join(upstreamDir, target, 'package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`[vendor] package 缺少 name/version：${target}`)
  }
  const tarball = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
  return {
    target,
    name: manifest.name,
    version: manifest.version,
    tarball,
    specifier: `file:../${tarball}`,
  }
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

function upstreamUntrackedFiles(): string[] {
  return capture(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    upstreamDir,
  ).split('\n').filter(line => line.startsWith('?? '))
}

/** 在临时 Git index 上构造 diff，避免污染 upstream 的真实 index。 */
function withScratchIndex<T>(prefix: string, fn: (indexEnv: Record<string, string>) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), prefix))
  const indexEnv = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    capture('git', ['read-tree', 'HEAD'], upstreamDir, indexEnv)
    return fn(indexEnv)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Build the exact tracked diff represented by the registered queue. */
function registeredPatchDiff(patches: readonly PatchEntry[]): string {
  return withScratchIndex('dsh-patch-index-', (indexEnv) => {
    for (const entry of patches) {
      capture('git', ['apply', '--cached', registeredPatchPath(entry.file)], upstreamDir, indexEnv)
    }
    return capture('git', ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], upstreamDir, indexEnv)
  })
}

/**
 * 补丁可以新建文件（如 0012/0013 的 rewind.ts），git apply 落到工作树后是
 * 未跟踪文件，`git diff HEAD` 看不见它们。经临时 index `git add --all` 把
 * 未跟踪内容一并纳入对比，「登记 diff === 实际 diff」的判定对新建文件才成立。
 * 被 .gitignore 忽略的产物（lib/、node_modules）不进 index，行为与此前一致。
 */
function actualUpstreamDiff(): string {
  return withScratchIndex('dsh-worktree-index-', (indexEnv) => {
    capture('git', ['add', '--all'], upstreamDir, indexEnv)
    return capture('git', ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], upstreamDir, indexEnv)
  })
}

/** Return the exact registered prefix represented by the current worktree. */
function appliedRegisteredPrefix(patches: readonly PatchEntry[]): number | null {
  const actual = actualUpstreamDiff()
  for (let length = patches.length; length >= 0; length -= 1) {
    if (actual === registeredPatchDiff(patches.slice(0, length))) return length
  }
  return null
}

function applyPatches(patches: readonly PatchEntry[]): void {
  if (patches.length === 0) {
    console.log('\n[patches] 无登记的补丁，跳过')
    return
  }
  for (const entry of patches) {
    if (!existsSync(registeredPatchPath(entry.file))) {
      throw new Error(`[patches] 登记的文件不存在：${entry.file}`)
    }
  }
  // Later patches may deliberately edit a hunk introduced by an earlier one,
  // so reverse-checking that earlier patch alone cannot identify a valid
  // aggregate state. Recognize an exact registered prefix instead: this keeps
  // repeat syncs idempotent and lets a newly appended patch apply incrementally.
  const appliedPrefix = appliedRegisteredPrefix(patches)
  if (appliedPrefix !== null) {
    if (appliedPrefix === patches.length) {
      console.log('\n[patches] 已精确套用完整登记队列，跳过')
      return
    }
    for (const entry of patches.slice(appliedPrefix)) {
      const patchPath = registeredPatchPath(entry.file)
      run('git', ['apply', '--check', patchPath], upstreamDir)
      run('git', ['apply', patchPath], upstreamDir)
      console.log(`[patches] 已套用：${entry.file}（${entry.reason}）`)
    }
    return
  }
  for (const entry of patches) {
    const patchPath = registeredPatchPath(entry.file)
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

/**
 * 用临时 Git index 构造“只套登记补丁”的标准 diff，拒绝 upstream 里的私改。
 * 未跟踪文件已由 actualUpstreamDiff 纳入 diff 对比：与登记补丁新建的完全一致
 * 则通过，否则 diff 不等即拒绝（报错时列出未跟踪文件便于定位）。
 */
function verifyOnlyRegisteredPatches(patches: readonly PatchEntry[]): void {
  if (actualUpstreamDiff() !== registeredPatchDiff(patches)) {
    const untracked = upstreamUntrackedFiles()
    const hint = untracked.length > 0 ? `\n当前未跟踪文件：\n${untracked.join('\n')}` : ''
    throw new Error(
      `[patches] upstream 工作树包含未登记修改，拒绝继续。请把变更制作成 patches/*.patch，或先恢复子模块。${hint}`,
    )
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

function packTargets(patches: readonly PatchEntry[]): PackedPackage[] {
  if (effectiveSkipPack) return []
  mkdirSync(vendorDir, { recursive: true })
  for (const old of readdirSync(vendorDir).filter((f) => f.endsWith('.tgz'))) {
    rmSync(join(vendorDir, old))
  }
  const packages = packTargetsFor(patches).map(packedPackage)
  for (const pkg of packages) {
    run('pnpm', ['pack', '--pack-destination', vendorDir], join(upstreamDir, pkg.target))
    if (!existsSync(join(vendorDir, pkg.tarball))) {
      throw new Error(`[vendor] pnpm pack 未生成预期文件：${pkg.tarball}`)
    }
  }
  console.log(`\n[vendor] 已生成：${readdirSync(vendorDir).join(', ')}`)
  return packages
}

/**
 * 把 CLI 与本次构建的本地 packages 安装成 vendor/dsh-cli/。
 * pnpm pack 会把 workspace 依赖改写成 registry 范围；所有补丁涉及的包
 * 必须同时作为本地依赖和 override，否则测试/build 虽绿，运行时仍是官方包。
 */
function installCli(packages: readonly PackedPackage[]): void {
  if (effectiveSkipPack) return
  const cliInstallDir = join(vendorDir, 'dsh-cli')
  mkdirSync(cliInstallDir, { recursive: true })
  const dependencies = Object.fromEntries(packages.map(pkg => [pkg.name, pkg.specifier]))
  const overrides = Object.fromEntries(
    packages.filter(pkg => pkg.name !== '@deepseek-ai/dsh').map(pkg => [pkg.name, pkg.specifier]),
  )
  if (dependencies['@deepseek-ai/dsh'] === undefined) {
    throw new Error('[vendor] 基础 CLI tarball 缺失：@deepseek-ai/dsh')
  }
  writeFileSync(
    join(cliInstallDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-desktop-cli-install',
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  )
  // pnpm 11 已把 overrides 从 package.json 的 `pnpm` 字段迁到
  // pnpm-workspace.yaml；放错位置会被静默忽略并安装出两个同版本实例。
  writeFileSync(
    join(cliInstallDir, 'pnpm-workspace.yaml'),
    yaml.dump({
      packages: [],
      overrides,
      // pnpm 11 默认禁止依赖安装脚本且将被禁视为失败；这些原生预编译
      // 与 subprocess-local 的 spawn helper 是运行时必需。
      allowBuilds: {
        '@deepseek-ai/dsh-subprocess-local': true,
        '@google/genai': true,
        koffi: true,
        'node-pty': true,
        protobufjs: true,
      },
      // hoisted 布局把全部依赖提升为单一 node_modules 目录,消除 isolated
      // 布局中 .pnpm/<pkg> 与顶层 hoisted 目录的两份实体冗余,显著降低
      // electron-builder 打包时的文件数与安装时长。
      nodeLinker: 'hoisted',
    }, { lineWidth: -1, noRefs: true }),
  )
  // 本地 tarball 每次同步都会以相同版本号重建。--force 让 pnpm 重新导入，
  // --no-frozen-lockfile 只更新 tarball integrity，同时复用其余锁定解析。
  run('pnpm', ['install', '--prod', '--force', '--no-frozen-lockfile'], cliInstallDir, { CI: 'true' })
  const lockfile = readFileSync(join(cliInstallDir, 'pnpm-lock.yaml'), 'utf8')
  for (const pkg of packages) {
    if (!lockfile.includes(`specifier: ${pkg.specifier}`)) {
      throw new Error(`[vendor] lockfile 未使用本地包：${pkg.name} -> ${pkg.specifier}`)
    }
  }
}

checkEnvironment()
const patches = readPatchRegistry()
applyPatches(patches)
verifyOnlyRegisteredPatches(patches)
const fingerprint = syncFingerprint(patches)
cleanIfInputsChanged(fingerprint)
installAndBuild()
const packed = packTargets(patches)
installCli(packed)
markFullySynced(fingerprint)
console.log('\nsync-upstream 完成 ✓')
