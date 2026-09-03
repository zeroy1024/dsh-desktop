/**
 * Start the built dsh Web CLI, fetch its ready URL, and shut it down.
 *
 * This is intentionally an HTTP smoke rather than an Electron test: it
 * exercises the same installed CLI closure that the desktop shell launches,
 * while remaining runnable on Linux, macOS, and Windows GitHub runners.
 * AgentSupervisor owns process-group termination on POSIX and the direct
 * child termination path on Windows.
 *
 * The agent runs under the desktop profile, so the app's bundled plugins are
 * loaded by dsh itself instead of being bypassed by the smoke. This requires
 * `pnpm build` first: the staged plugin closure it produces is materialized
 * into the temporary DSH_HOME as symlinks. Use `--no-profile` to fall back to
 * the bare web profile (missing staged plugins fail otherwise).
 *
 * Usage:
 *   pnpm exec tsx scripts/smoke-dsh.ts
 *   pnpm exec tsx scripts/smoke-dsh.ts --cli-entry <path/to/lib/bin.js>
 *   pnpm exec tsx scripts/smoke-dsh.ts --no-profile
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AgentSupervisor, type AgentReadyInfo } from '../packages/agent-host/src/supervisor'
import type { BundledPlugin } from '../packages/agent-host/src/desktop-profile'
import { materializeDesktopProfile } from '../packages/agent-host/src/desktop-profile'

export interface WebSmokeResponse {
  status: number
  contentType: string
  bodyBytes: number
}

export interface DshSmokeResult extends WebSmokeResponse {
  url: string
  port: number
}

export interface DshSmokeOptions {
  /** Absolute path to vendor/dsh-cli's installed @deepseek-ai/dsh/lib/bin.js. */
  cliEntry?: string
  /** Keep the temporary DSH_HOME after a successful smoke for local debugging. */
  keepHome?: boolean
  /** Supervisor ready-line timeout. */
  startupTimeoutMs?: number
  /** HTTP request timeout. */
  requestTimeoutMs?: number
  /** Additional environment values passed to dsh. */
  env?: Record<string, string>
  /** 装配 desktop profile 的内置插件；缺省解析 staged 闭包（需先 pnpm build）。 */
  plugins?: BundledPlugin[]
  /** 跳过 desktop profile 装配（仅测试与最小复现用，不加 profile 版参数）。 */
  noProfile?: boolean
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultCliEntry = join(
  rootDir,
  'vendor',
  'dsh-cli',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
)
/** build 的 stage:plugins 把 enabled 插件 staging 到 dsh CLI 闭包的 @dsh-desktop 作用域。 */
const stagedPluginsDir = join(rootDir, 'vendor', 'dsh-cli', 'node_modules', '@dsh-desktop')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 扫描一个目录里的内置插件包，镜像 apps/desktop/src/main/bundled-plugins.ts 的
 * 判定（name 合法 + `dshDesktop.enabled: false` 跳过）；此副本独立于此地，因为
 * bundled-plugins.ts 依赖 electron 的 `app` 不可在脚本进程复用。staged 闭包本身
 * 已由 stage:plugins 排除 enabled:false 的插件，此判定是对手工拷贝的兜底。
 */
export function scanStagedPlugins(pluginsRoot: string): BundledPlugin[] {
  const plugins: BundledPlugin[] = []
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(pluginsRoot, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string
      dshDesktop?: { enabled?: boolean }
    }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    if (manifest.dshDesktop?.enabled === false) continue
    plugins.push({ name: manifest.name, dir })
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  if (plugins.length === 0) {
    throw new Error(`staged 插件为空（${pluginsRoot}），异常`)
  }
  return plugins
}

/**
 * 解析 stage:plugins 产出的 staged 插件闭包，供 desktop profile 物化。
 *
 * @param pluginsDir 插件目录；缺省为 vendor/dsh-cli 闭包里的 @dsh-desktop 作用域。
 */
export function resolveStagedPlugins(pluginsDir: string = stagedPluginsDir): BundledPlugin[] {
  if (!existsSync(pluginsDir)) {
    throw new Error(`未找到 staged 插件闭包：${pluginsDir}；请先运行 pnpm build（stage:plugins 产出 staged 闭包）。`)
  }
  return scanStagedPlugins(pluginsDir)
}

/**
 * Validate the response returned by the dsh Web fallback. Kept pure so the
 * smoke contract can be unit-tested without booting the heavyweight CLI.
 */
export function validateWebResponse(status: number, contentType: string, body: string): WebSmokeResponse {
  if (status !== 200) {
    throw new Error(`dsh Web GET returned HTTP ${String(status)} (expected 200)`)
  }
  if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) {
    throw new Error(`dsh Web GET returned unexpected content-type ${JSON.stringify(contentType)}`)
  }
  if (!/<html(?:\s|>)/iu.test(body) || !/<(?:[^>]+\s)?id=["']root["'][^>]*>/iu.test(body)) {
    throw new Error('dsh Web GET did not return an HTML document with #root')
  }
  return { status, contentType, bodyBytes: Buffer.byteLength(body, 'utf8') }
}

async function getWebPage(url: string, timeoutMs: number): Promise<WebSmokeResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'text/html' },
    })
    const body = await response.text()
    return validateWebResponse(response.status, response.headers.get('content-type') ?? '', body)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`dsh Web GET 超时（${String(timeoutMs)}ms）：${url}`, { cause: error })
    }
    throw new Error(`dsh Web GET 失败（${url}）：${errorMessage(error)}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

function assertLoopbackReady(ready: AgentReadyInfo): void {
  let parsed: URL
  try {
    parsed = new URL(ready.url)
  } catch {
    throw new Error(`dsh ready URL 无效：${ready.url}`)
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || ready.port <= 0) {
    throw new Error(`dsh ready URL 非预期（必须为 127.0.0.1 的随机 HTTP 端口）：${ready.url}`)
  }
}

function copyCiDiagnostics(logDir: string): string | null {
  const configured = process.env.CI_ARTIFACT_DIR
  if (configured === undefined || !existsSync(logDir)) return null
  const destination = resolve(rootDir, configured, `dsh-${process.platform}`)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(logDir, destination, { recursive: true })
  return destination
}

/**
 * Run the cross-platform dsh web smoke. A fresh DSH_HOME is used for every
 * invocation so no developer credentials or profiles leak into CI.
 */
export async function runDshSmoke(options: DshSmokeOptions = {}): Promise<DshSmokeResult> {
  const cliEntry = resolve(options.cliEntry ?? defaultCliEntry)
  if (!existsSync(cliEntry)) {
    throw new Error(
      `未找到 dsh CLI 入口：${cliEntry}；请先运行 pnpm sync:upstream（并完成 vendor/dsh-cli 安装）。`,
    )
  }

  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-ci-'))
  const logDir = join(dshHome, 'logs')
  // dsh 级 smoke 默认走 desktop profile：13 个内置插件在 dsh 子进程里同样装配，
  // 避免 CI 只覆盖裸 web profile、把插件旁路。staged 闭包缺失时给出可操作错误。
  if (options.noProfile !== true) {
    materializeDesktopProfile({
      dshHome,
      plugins: options.plugins ?? resolveStagedPlugins(),
      version: 'ci-smoke',
    })
  }
  const supervisor = new AgentSupervisor({
    cliEntry,
    dshHome,
    logDir,
    startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
    // A smoke must never leave a server behind if the HTTP assertion fails.
    stopGraceMs: 5_000,
    profileArgs: options.noProfile === true
      ? ['--profile', 'web', '--no-open', '--port', '0']
      : ['--profile', 'desktop', '--no-open', '--port', '0'],
    env: {
      DSH_TELEMETRY_DISABLED: '1',
      ...options.env,
    },
  })

  let succeeded = false
  let ready: AgentReadyInfo | null = null
  let result: DshSmokeResult | undefined
  let failure: unknown
  try {
    ready = await supervisor.start()
    assertLoopbackReady(ready)
    const response = await getWebPage(ready.url, options.requestTimeoutMs ?? 15_000)
    succeeded = true
    result = { ...response, url: ready.url, port: ready.port }
  } catch (error) {
    failure = new Error(
      `dsh Web smoke failed${ready === null ? '' : ` after ready at ${ready.url}`}: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  let stopError: unknown
  try {
    await supervisor.stop()
  } catch (error) {
    stopError = error
  }
  if (stopError !== undefined) {
    if (failure === undefined) {
      failure = new Error(`dsh Web smoke 清理失败：${errorMessage(stopError)}`, { cause: stopError })
    } else {
      console.error(`[dsh-smoke] 清理 agent 失败：${errorMessage(stopError)}`)
    }
  }
    if (succeeded && !options.keepHome) {
      rmSync(dshHome, { recursive: true, force: true })
    } else {
      console.error(`[dsh-smoke] diagnostics kept at ${logDir}`)
      const copied = copyCiDiagnostics(logDir)
      if (copied !== null) console.error(`[dsh-smoke] CI diagnostics copied to ${copied}`)
    }
  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error('dsh Web smoke 未产生结果')
  return result
}

interface CliOptions extends DshSmokeOptions {
  cliEntry: string
  help: boolean
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} 必须是正整数`)
  return parsed
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = { cliEntry: defaultCliEntry, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--cli-entry': {
        const value = argv[index + 1]
        if (value === undefined || value.trim() === '') throw new Error('--cli-entry 需要路径')
        options.cliEntry = resolve(value)
        index += 1
        break
      }
      case '--no-profile': options.noProfile = true; break
      case '--startup-timeout-ms': {
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--startup-timeout-ms 需要数值')
        options.startupTimeoutMs = parsePositiveInteger(value, '--startup-timeout-ms')
        index += 1
        break
      }
      case '--request-timeout-ms': {
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--request-timeout-ms 需要数值')
        options.requestTimeoutMs = parsePositiveInteger(value, '--request-timeout-ms')
        index += 1
        break
      }
      case '--keep-home': options.keepHome = true; break
      case '--help':
      case '-h':
        console.log([
          'Usage: smoke-dsh [options]',
          '',
          '  --cli-entry <path>          dsh CLI lib/bin.js path',
          '  --no-profile                bare web profile (no bundled plugins)',
          '  --startup-timeout-ms <ms>   ready-line timeout',
          '  --request-timeout-ms <ms>   HTTP GET timeout',
          '  --keep-home                 retain temporary DSH_HOME',
        ].join('\n'))
        options.help = true
        return options
      default:
        throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv)
  if (options.help) return
  const result = await runDshSmoke(options)
  console.log(`[dsh-smoke] OK ${result.url} HTTP ${String(result.status)} (${String(result.bodyBytes)} bytes)`)
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`[dsh-smoke] ${errorMessage(error)}`)
    process.exitCode = 1
  })
}
