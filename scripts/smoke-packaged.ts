/**
 * Launch the exact Electron binary produced by electron-builder's `--dir`
 * target and require the same startup contract as the unpackaged smoke.
 *
 * The release workflow passes the directory containing the platform-specific
 * unpacked output:
 *
 *   pnpm exec tsx scripts/smoke-packaged.ts --release-dir release
 *
 * The smoke deliberately starts the binary directly (without `open`, a shell,
 * or an installer) so that the process tree and the files being exercised are
 * the ones produced by the packaging job.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const packagedSmokeSentinel = '[ci-smoke] DSH_DESKTOP_READY'
/**
 * GUI-subsystem processes on Windows do not always expose inherited stdout.
 * The packaged app may write this marker to DSH_HOME at the same point as the
 * stdout sentinel; the smoke accepts either signal. The DSH_HOME is fresh for
 * every invocation, so marker existence cannot be a stale success.
 */
export const packagedSmokeReadyMarker = '.dsh-desktop-ci-ready.json'
const defaultTimeoutMs = 120_000
const outputLimit = 2 * 1024 * 1024
const stopGraceMs = 3_000
const stopForceMs = 5_000
const taskkillTimeoutMs = 2_000

type PackagedPlatform = 'darwin' | 'win32' | 'linux'

export interface PackagedSmokeOptions {
  /** Directory passed to electron-builder's `--dir` output. */
  releaseDir: string
  /** Maximum time to wait for the ready sentinel and clean application exit. */
  timeoutMs?: number
  /** Retain the isolated DSH_HOME after a successful local smoke. */
  keepHome?: boolean
  /** Additional environment values for local diagnostics. Required smoke
   * variables are applied after this map and cannot be overridden. */
  env?: Record<string, string>
}

export interface PackagedSmokeResult {
  executable: string
  platform: PackagedPlatform
}

interface ChildCloseResult {
  code: number | null
  signal: NodeJS.Signals | null
  error: Error | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPackagedPlatform(platform: NodeJS.Platform): platform is PackagedPlatform {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isLaunchableFile(path: string, platform: PackagedPlatform): boolean {
  if (!isRegularFile(path)) return false
  if (platform === 'win32') return extname(path).toLowerCase() === '.exe'
  // Windows does not expose POSIX executable mode bits. This branch also
  // keeps fixture-based inspection of macOS/Linux layouts portable.
  if (process.platform === 'win32') return true
  try {
    // electron-builder preserves the executable bit on POSIX unpacked output.
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function directoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function walkDirectories(root: string, maxDepth: number): string[] {
  const result: string[] = []
  const visit = (directory: string, depth: number): void => {
    if (!isDirectory(directory)) return
    result.push(directory)
    if (depth >= maxDepth) return
    for (const entry of directoryEntries(directory)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      visit(join(directory, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  return result
}

function normalizedExecutableName(path: string): string {
  return basename(path)
    .replace(/\.(?:exe|app)$/iu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '')
}

function executableScore(path: string, platform: PackagedPlatform): number {
  const name = normalizedExecutableName(path)
  if (name === 'deepseekharness') return 0
  if (name.includes('deepseekharness')) return 1
  if (/^(?:chrome|chromesandbox|chromecrashpadhandler|elevate|uninstall)/u.test(name)) {
    return Number.POSITIVE_INFINITY
  }
  if (name.includes('helper') || name.includes('renderer') || name.includes('crashpad')) {
    return Number.POSITIVE_INFINITY
  }
  // Windows output is expected to contain the product .exe. On POSIX a
  // custom executableName is possible, so an executable fallback is useful.
  return platform === 'win32' ? Number.POSITIVE_INFINITY : 2
}

function chooseExecutable(directory: string, platform: PackagedPlatform): string | null {
  const candidates = directoryEntries(directory)
    .filter((entry) => !entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(directory, entry.name))
    .filter((path) => isLaunchableFile(path, platform))
    .map((path) => ({ path, score: executableScore(path, platform) }))
    .filter(({ score }) => Number.isFinite(score))
    .toSorted((left, right) => left.score - right.score || left.path.localeCompare(right.path))
  return candidates[0]?.path ?? null
}

function unpackedDirectoryPattern(platform: PackagedPlatform): RegExp {
  switch (platform) {
    case 'win32': return /^win(?:-[a-z0-9]+)?-unpacked$/iu
    case 'linux': return /^linux(?:-[a-z0-9]+)?-unpacked$/iu
    case 'darwin': return /^mac(?:-[a-z0-9]+)?$/iu
  }
}

function findUnpackedDirectories(root: string, platform: Exclude<PackagedPlatform, 'darwin'>): string[] {
  const pattern = unpackedDirectoryPattern(platform)
  return walkDirectories(root, 3)
    .filter((path) => pattern.test(basename(path)))
    .toSorted((left, right) => left.localeCompare(right))
}

function findMacBundles(root: string): string[] {
  return walkDirectories(root, 5)
    .filter((path) => basename(path).toLowerCase().endsWith('.app'))
    .toSorted((left, right) => left.localeCompare(right))
}

function platformLayoutHint(platform: PackagedPlatform): string {
  switch (platform) {
    case 'darwin': return '<release-dir>/mac*/<Product Name>.app/Contents/MacOS/<Product Name>'
    case 'win32': return '<release-dir>/win*-unpacked/<Product Name>.exe'
    case 'linux': return '<release-dir>/linux*-unpacked/<executableName>'
  }
}

/**
 * Locate the platform executable in an electron-builder unpacked directory.
 *
 * `releaseDir` may be the common electron-builder output root (`release`) or
 * the platform-specific directory itself (`linux-unpacked`, `win-unpacked`,
 * or a `.app` bundle). No installer is accepted here: this function only
 * returns an executable from the `--dir` layout.
 */
export function locatePackagedExecutable(
  releaseDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!isPackagedPlatform(platform)) {
    throw new Error(`打包 Electron smoke 不支持平台：${platform}`)
  }
  const root = resolve(releaseDir)
  if (!isDirectory(root)) throw new Error(`release-dir 不是目录：${root}`)

  let executable: string | null = null
  if (platform === 'darwin') {
    for (const appBundle of findMacBundles(root)) {
      executable = chooseExecutable(join(appBundle, 'Contents', 'MacOS'), platform)
      if (executable !== null) break
    }
  } else {
    const unpacked = findUnpackedDirectories(root, platform)
    // walkDirectories includes root itself, so directly passing an unpacked
    // directory remains supported without ever falling back to an installer.
    for (const directory of unpacked) {
      executable = chooseExecutable(directory, platform)
      if (executable !== null) break
    }
  }

  if (executable === null) {
    throw new Error(
      `未找到 ${platform} electron-builder 未打包可执行文件：${root}；` +
      `期望布局：${platformLayoutHint(platform)}`,
    )
  }
  return resolve(executable)
}

export function packagedResourcesDir(executable: string, platform: NodeJS.Platform): string {
  if (!isPackagedPlatform(platform)) {
    throw new Error(`打包 Electron smoke 不支持平台：${platform}`)
  }
  return platform === 'darwin'
    ? join(dirname(dirname(executable)), 'Resources')
    : join(dirname(executable), 'resources')
}

function verifyPackagedRuntime(executable: string, platform: PackagedPlatform): void {
  const dshCli = join(packagedResourcesDir(executable, platform), 'dsh-cli')
  const cliEntry = join(dshCli, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const plugins = join(dshCli, 'node_modules', '@dsh-desktop')
  if (!isRegularFile(cliEntry)) {
    throw new Error(`打包产物缺少 dsh CLI 入口：${cliEntry}`)
  }
  if (!isDirectory(plugins)) {
    throw new Error(`打包产物缺少内置插件闭包：${plugins}`)
  }
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString()
  return next.length <= outputLimit ? next : next.slice(-outputLimit)
}

export function isValidPackagedSmokeReadyMarker(path: string, platform: NodeJS.Platform): boolean {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof value !== 'object' || value === null) return false
    const marker = value as { ready?: unknown; platform?: unknown; pid?: unknown }
    return marker.ready === true
      && marker.platform === platform
      && Number.isSafeInteger(marker.pid)
      && Number(marker.pid) > 0
  } catch {
    return false
  }
}

/** Send a signal to the app and all descendants without waiting indefinitely. */
function terminateProcessTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
        stdio: 'ignore',
        timeout: taskkillTimeoutMs,
        windowsHide: true,
      })
    } catch {
      // A process that exited between the liveness check and taskkill is
      // already clean; a later bounded force pass handles the other case.
    }
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // The child may have exited in the race between the two checks.
    }
  }
}

async function closesWithin(closed: Promise<ChildCloseResult>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function stopProcessTree(child: ChildProcess, closed: Promise<ChildCloseResult>): Promise<void> {
  terminateProcessTree(child, false)
  if (await closesWithin(closed, stopGraceMs)) return
  terminateProcessTree(child, true)
  if (!await closesWithin(closed, stopForceMs)) {
    throw new Error(`Electron 打包 smoke 进程树未能终止（pid=${String(child.pid)}）`)
  }
}

function observeClose(child: ChildProcess): Promise<ChildCloseResult> {
  return new Promise<ChildCloseResult>((resolvePromise) => {
    let spawnError: Error | null = null
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => {
      resolvePromise({ code, signal, error: spawnError })
    })
  })
}

function writeFailureArtifacts(
  scratch: string,
  releaseDir: string,
  executable: string,
  stdout: string,
  stderr: string,
): string {
  const configured = process.env.CI_ARTIFACT_DIR ?? '.ci-artifacts'
  const base = resolve(rootDir, configured)
  const destination = join(base, `electron-packaged-${process.platform}`)
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'stdout.log'), stdout)
  writeFileSync(join(destination, 'stderr.log'), stderr)
  writeFileSync(join(destination, 'release-dir.txt'), `${releaseDir}\n`)
  writeFileSync(join(destination, 'executable.txt'), `${executable}\n`)
  const logs = join(scratch, 'electron-user-data', 'logs')
  if (existsSync(logs)) cpSync(logs, join(destination, 'app-logs'), { recursive: true })
  const readyMarker = join(scratch, packagedSmokeReadyMarker)
  if (existsSync(readyMarker)) cpSync(readyMarker, join(destination, packagedSmokeReadyMarker))
  return destination
}

async function waitForCloseOrTimeout(
  closed: Promise<ChildCloseResult>,
  timeoutMs: number,
): Promise<ChildCloseResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      closed,
      new Promise<null>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function removeScratch(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/**
 * Run the packaged Electron startup smoke with a fresh DSH_HOME. The
 * application itself owns shutdown after emitting DSH_DESKTOP_READY; the
 * runner only intervenes on timeout or a failed startup.
 */
export async function runPackagedSmoke(options: PackagedSmokeOptions): Promise<PackagedSmokeResult> {
  const platform = process.platform
  if (!isPackagedPlatform(platform)) {
    throw new Error(`打包 Electron smoke 不支持平台：${platform}`)
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`打包 Electron smoke timeout 必须是正整数：${String(timeoutMs)}`)
  }
  const executable = locatePackagedExecutable(options.releaseDir, platform)
  verifyPackagedRuntime(executable, platform)
  const releaseDir = resolve(options.releaseDir)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-packaged-smoke-'))
  let stdout = ''
  let stderr = ''
  let streamReady = false
  let stdoutSentinelTail = ''
  let stderrSentinelTail = ''
  let child: ChildProcess | null = null
  let closed: Promise<ChildCloseResult> | null = null
  let passed = false
  let runError: unknown
  let cleanupError: unknown
  let artifactError: unknown

  try {
    child = spawn(executable, [], {
      cwd: rootDir,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...options.env,
        CI: 'true',
        DSH_DESKTOP_CI_SMOKE: '1',
        DSH_HOME: scratch,
        DSH_TELEMETRY_DISABLED: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    closed = observeClose(child)
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      const combined = stdoutSentinelTail + text
      streamReady ||= combined.includes(packagedSmokeSentinel)
      stdoutSentinelTail = combined.slice(-packagedSmokeSentinel.length)
      stdout = boundedAppend(stdout, chunk)
      process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      const combined = stderrSentinelTail + text
      streamReady ||= combined.includes(packagedSmokeSentinel)
      stderrSentinelTail = combined.slice(-packagedSmokeSentinel.length)
      stderr = boundedAppend(stderr, chunk)
      process.stderr.write(chunk)
    })

    const outcome = await waitForCloseOrTimeout(closed, timeoutMs)
    if (outcome === null) throw new Error(`打包 Electron smoke 超时（${timeoutMs}ms）`)
    if (outcome.error !== null) throw outcome.error
    const markerReady = isValidPackagedSmokeReadyMarker(
      join(scratch, packagedSmokeReadyMarker),
      process.platform,
    )
    if (!streamReady && !markerReady) {
      throw new Error(
        `打包 Electron 在 ready sentinel/marker 前退出（code=${String(outcome.code)}, signal=${String(outcome.signal)}）`,
      )
    }
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(
        `打包 Electron smoke 未干净退出（code=${String(outcome.code)}, signal=${String(outcome.signal)}）`,
      )
    }
    passed = true
    console.log(`[ci-smoke] Packaged Electron startup passed on ${process.platform}`)
  } catch (error) {
    runError = new Error(`Packaged Electron smoke failed: ${errorMessage(error)}`, { cause: error })
  } finally {
    if (child !== null && closed !== null
      && child.exitCode === null && child.signalCode === null) {
      try {
        await stopProcessTree(child, closed)
      } catch (error) {
        cleanupError = error
      }
    }
    if (!passed) {
      try {
        const destination = writeFailureArtifacts(scratch, releaseDir, executable, stdout, stderr)
        console.error(`[ci-smoke] packaged failure artifacts: ${destination}`)
      } catch (error) {
        artifactError = error
        console.error(`[ci-smoke] packaged failure artifacts unavailable: ${errorMessage(error)}`)
        console.error(`[ci-smoke] packaged smoke scratch retained at ${scratch}`)
      }
    }
    if (options.keepHome || (!passed && artifactError !== undefined)) {
      console.error(`[ci-smoke] packaged smoke DSH_HOME retained at ${scratch}`)
    } else {
      try {
        removeScratch(scratch)
      } catch (error) {
        cleanupError = cleanupError === undefined
          ? error
          : new AggregateError([cleanupError, error], '打包 Electron smoke 清理失败')
      }
    }
  }

  const failures = [runError, cleanupError, artifactError].filter((failure): failure is Error => failure !== undefined)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, '打包 Electron smoke 与清理均失败')
  return { executable, platform }
}

interface CliOptions extends PackagedSmokeOptions {
  help: boolean
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} 必须是正整数`)
  return parsed
}

export function parsePackagedSmokeOptions(argv: readonly string[]): CliOptions {
  let releaseDir: string | undefined
  const options: Omit<CliOptions, 'releaseDir'> & { releaseDir?: string } = { help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--': break
      case '--release-dir': {
        const value = argv[index + 1]
        if (value === undefined || value.trim() === '') throw new Error('--release-dir 需要路径')
        releaseDir = resolve(value)
        index += 1
        break
      }
      case '--timeout-ms': {
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--timeout-ms 需要数值')
        options.timeoutMs = parsePositiveInteger(value, '--timeout-ms')
        index += 1
        break
      }
      case '--keep-home': options.keepHome = true; break
      case '--help':
      case '-h':
        console.log([
          'Usage: smoke-packaged --release-dir <path> [options]',
          '',
          '  --release-dir <path>  electron-builder --dir output root',
          '  --timeout-ms <ms>     ready/exit timeout (default: 120000)',
          '  --keep-home           retain temporary DSH_HOME',
        ].join('\n'))
        return { ...options, releaseDir: resolve(releaseDir ?? join(rootDir, 'release')), help: true }
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  if (releaseDir === undefined) throw new Error('--release-dir 是必需参数')
  return { ...options, releaseDir, help: false }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parsePackagedSmokeOptions(argv)
  if (options.help) return
  const result = await runPackagedSmoke(options)
  console.log(`[packaged-smoke] OK ${relative(rootDir, result.executable)}`)
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`[ci-smoke] ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
