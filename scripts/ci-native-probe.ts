/**
 * Validate the native parts of the dsh installation closure used by CI.
 *
 * `vendor/dsh-cli` is an isolated pnpm installation.  Its package.json does
 * not directly depend on node-pty, koffi, or sharp, so resolving those names
 * from the vendor root is intentionally not supported.  Resolve each module
 * from the upstream package that declares it instead; this catches both a
 * missing dependency and an ABI/prebuild mismatch on the current runner.
 *
 * Usage:
 *   pnpm exec tsx scripts/ci-native-probe.ts
 *   pnpm exec tsx scripts/ci-native-probe.ts --vendor-dir ./vendor/dsh-cli
 */
import { createRequire } from 'node:module'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type RequiredNativeModule = 'node-pty' | 'koffi' | 'sharp'

export interface NativeModuleSpec {
  name: RequiredNativeModule
  /** The upstream package whose manifest declares this direct dependency. */
  provider: string
}

export const REQUIRED_NATIVE_MODULES: readonly NativeModuleSpec[] = [
  { name: 'node-pty', provider: '@deepseek-ai/dsh-subprocess-local' },
  { name: 'koffi', provider: '@deepseek-ai/dsh-fs-local' },
  { name: 'sharp', provider: '@deepseek-ai/dsh-attachment-local' },
]

export interface NativePackageResolution {
  name: RequiredNativeModule
  provider: string
  providerManifest: string
  packageManifest: string
  entry: string
  version: string
}

export interface NativeProbeOptions {
  vendorDir?: string
  platform?: NodeJS.Platform
  architecture?: string
}

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultVendorDir = join(scriptRoot, 'vendor', 'dsh-cli')

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function packageSegments(name: string): string[] {
  return name.startsWith('@') ? name.split('/') : [name]
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) } catch { return absolute }
}

function readManifest(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function manifestName(path: string): string | null {
  const manifest = readManifest(path)
  return typeof manifest?.name === 'string' ? manifest.name : null
}

/**
 * Find a package manifest in vendor's pnpm virtual store without traversing
 * arbitrary directories outside the installation closure.
 */
export function findVendorPackageManifest(vendorDir: string, packageName: string): string | null {
  const vendorRoot = canonicalPath(vendorDir)
  const nodeModules = join(vendorRoot, 'node_modules')
  const segments = packageSegments(packageName)
  const candidates: string[] = [
    join(nodeModules, ...segments, 'package.json'),
    join(nodeModules, '.pnpm', 'node_modules', ...segments, 'package.json'),
  ]
  const virtualStore = join(nodeModules, '.pnpm')
  try {
    for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      candidates.push(join(virtualStore, entry.name, 'node_modules', ...segments, 'package.json'))
    }
  } catch {
    // The caller turns a missing vendor closure into an actionable error.
  }

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const absolute = resolve(candidate)
    if (seen.has(absolute) || !existsSync(absolute)) continue
    seen.add(absolute)
    let physical: string
    try {
      physical = realpathSync(absolute)
    } catch {
      continue
    }
    if (!isWithin(vendorRoot, physical)) continue
    if (manifestName(physical) !== packageName) continue
    return physical
  }
  return null
}

function directDependency(manifest: Record<string, unknown>, packageName: string): boolean {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies']
  return sections.some((section) => {
    const dependencies = manifest[section]
    return typeof dependencies === 'object'
      && dependencies !== null
      && Object.prototype.hasOwnProperty.call(dependencies, packageName)
  })
}

function nearestPackageManifest(entry: string, packageName: string, vendorDir: string): string | null {
  const vendorRoot = canonicalPath(vendorDir)
  let directory = statSync(entry).isDirectory() ? entry : dirname(entry)
  while (isWithin(vendorRoot, directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const physical = (() => {
        try { return realpathSync(manifest) } catch { return null }
      })()
      if (physical !== null && manifestName(physical) === packageName) return physical
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/**
 * Resolve one native module from the direct dependency declaration that owns
 * it.  The returned paths are all physically inside vendor/dsh-cli.
 */
export function resolveNativePackage(
  vendorDir: string,
  spec: NativeModuleSpec | RequiredNativeModule,
): NativePackageResolution {
  const selected = typeof spec === 'string'
    ? REQUIRED_NATIVE_MODULES.find((candidate) => candidate.name === spec)
    : spec
  if (selected === undefined) throw new Error(`未知 native module：${String(spec)}`)

  const vendorRoot = canonicalPath(vendorDir)
  if (!existsSync(vendorRoot)) {
    throw new Error(`vendor/dsh-cli 不存在：${vendorRoot}；请先运行 pnpm sync:upstream`)
  }
  const providerManifest = findVendorPackageManifest(vendorRoot, selected.provider)
  if (providerManifest === null) {
    throw new Error(
      `${selected.name} 的 provider ${selected.provider} 不在 vendor/dsh-cli 闭包中：${vendorRoot}`
        + '；请先运行 pnpm sync:upstream，再在当前 runner 执行 vendor 安装。',
    )
  }
  const provider = readManifest(providerManifest)
  if (provider === null || !directDependency(provider, selected.name)) {
    throw new Error(
      `${selected.provider}/package.json 未声明直接依赖 ${selected.name}：${providerManifest}`
        + '；请检查上游包版本或更新 CI probe 的 provider 映射。',
    )
  }

  let entry: string
  try {
    const providerRequire = createRequire(providerManifest)
    entry = providerRequire.resolve(selected.name)
  } catch (error) {
    throw new Error(
      `${selected.name} 已在 ${selected.provider} 中声明，但无法从 vendor 闭包解析：${displayError(error)}`
        + `；请在 ${vendorRoot} 执行 pnpm install --frozen-lockfile。`,
      { cause: error },
    )
  }
  const physicalEntry = (() => {
    try { return realpathSync(entry) } catch { return null }
  })()
  if (physicalEntry === null || !isWithin(vendorRoot, physicalEntry)) {
    throw new Error(
      `${selected.name} 解析到了 vendor 闭包之外：${entry}`
        + `；provider=${selected.provider}，vendor=${vendorRoot}`,
    )
  }
  const packageManifest = nearestPackageManifest(physicalEntry, selected.name, vendorRoot)
  if (packageManifest === null) {
    throw new Error(`${selected.name} 的 package.json 无法从解析入口定位：${physicalEntry}`)
  }
  const packageData = readManifest(packageManifest)
  const version = typeof packageData?.version === 'string' ? packageData.version : 'unknown'
  return {
    name: selected.name,
    provider: selected.provider,
    providerManifest,
    packageManifest,
    entry: physicalEntry,
    version,
  }
}

function environmentForPty(): Record<string, string | undefined> {
  return { ...process.env, TERM: 'xterm' }
}

async function validateNodePty(moduleValue: unknown): Promise<void> {
  const pty = moduleValue as {
    spawn?: (file: string, args: string[], options: Record<string, unknown>) => {
      onExit: (listener: (event: { exitCode: number }) => void) => unknown
      kill: () => void
    }
  }
  if (typeof pty.spawn !== 'function') throw new Error('导出缺少 spawn()')
  const windows = process.platform === 'win32'
  const shell = windows ? (process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh'
  const args = windows ? ['/d', '/s', '/c', 'exit 0'] : ['-c', 'exit 0']
  const terminal = pty.spawn(shell, args, {
    name: 'xterm',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: environmentForPty(),
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { terminal.kill() } catch { /* already exited */ }
      rejectPromise(new Error('pty spawn smoke 超时（5s）'))
    }, 5_000)
    terminal.onExit((event) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (event.exitCode === 0) resolvePromise()
      else rejectPromise(new Error(`pty 子进程退出码 ${String(event.exitCode)}`))
    })
  })
}

function validateKoffi(moduleValue: unknown): void {
  const koffi = moduleValue as { version?: unknown; load?: (path: string) => unknown }
  if (typeof koffi.version !== 'string') throw new Error('导出缺少 version')
  if (typeof koffi.load !== 'function') throw new Error('导出缺少 load()')
  const libraries = process.platform === 'win32'
    ? ['kernel32.dll']
    : process.platform === 'darwin'
      ? ['/usr/lib/libSystem.B.dylib', 'libSystem.B.dylib']
      : [
          'libc.so.6',
          `libc.musl-${process.arch === 'arm64' ? 'aarch64' : process.arch}.so.1`,
          'libc.so',
        ]
  let lastError: unknown
  for (const library of libraries) {
    try {
      const handle = koffi.load(library)
      if (handle !== undefined && handle !== null) return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`无法加载系统 FFI library：${displayError(lastError)}`)
}

async function validateSharp(moduleValue: unknown): Promise<void> {
  const sharp = moduleValue as ((input: { create: {
    width: number
    height: number
    channels: number
    background: { r: number; g: number; b: number; alpha: number }
  } }) => { png: () => { toBuffer: () => Promise<unknown> } }) & {
    versions?: Record<string, unknown>
  }
  if (typeof sharp !== 'function') throw new Error('导出不是可调用的 sharp 工厂')
  const output = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer()
  if (!Buffer.isBuffer(output) || output.length === 0) {
    throw new Error('1x1 PNG 编解码 smoke 未返回有效 Buffer')
  }
}

async function validateLoadedModule(resolution: NativePackageResolution, moduleValue: unknown): Promise<void> {
  switch (resolution.name) {
    case 'node-pty': await validateNodePty(moduleValue); return
    case 'koffi': validateKoffi(moduleValue); return
    case 'sharp': await validateSharp(moduleValue); return
  }
}

/** Load and exercise every required native module in the vendor closure. */
export async function probeNativeModules(options: NativeProbeOptions = {}): Promise<NativePackageResolution[]> {
  const vendorDir = resolve(options.vendorDir ?? defaultVendorDir)
  const platform = options.platform ?? process.platform
  const architecture = options.architecture ?? process.arch
  const failures: string[] = []
  const successful: NativePackageResolution[] = []
  for (const spec of REQUIRED_NATIVE_MODULES) {
    try {
      const resolution = resolveNativePackage(vendorDir, spec)
      const providerRequire = createRequire(resolution.providerManifest)
      const moduleValue: unknown = providerRequire(spec.name)
      await validateLoadedModule(resolution, moduleValue)
      successful.push(resolution)
      console.log(`[native] ${spec.name}@${resolution.version} OK (${resolution.entry})`)
    } catch (error) {
      failures.push(
        `${spec.name}: ${displayError(error)}\n`
          + `  runner=${platform}/${architecture}; provider=${spec.provider}`,
      )
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `vendor native module probe failed for ${vendorDir}:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    )
  }
  return successful
}

interface CliOptions {
  vendorDir: string
  help: boolean
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let vendorDir = defaultVendorDir
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--vendor-dir') {
      const value = argv[index + 1]
      if (value === undefined || value.trim() === '') throw new Error('--vendor-dir 需要路径')
      vendorDir = resolve(value)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: ci-native-probe [--vendor-dir <vendor/dsh-cli>]')
      return { vendorDir, help: true }
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return { vendorDir, help: false }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv)
  if (options.help) return
  await probeNativeModules(options)
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`[native] ${displayError(error)}`)
    process.exitCode = 1
  })
}
