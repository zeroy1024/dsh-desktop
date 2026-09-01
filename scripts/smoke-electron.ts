/**
 * Launch the real unpackaged Electron application and require a clean,
 * self-terminating startup. The main process emits its sentinel only after:
 *
 *   dsh ready -> WebUI mounted -> desktop plugin/preload markers verified.
 *
 * Linux callers must provide a display (the GitHub workflow uses Xvfb).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = join(rootDir, 'apps', 'desktop')
const sentinel = '[ci-smoke] DSH_DESKTOP_READY'
const timeoutMs = 120_000
const outputLimit = 2 * 1024 * 1024

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString()
  return next.length <= outputLimit ? next : next.slice(-outputLimit)
}

function terminateTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
  }
}

interface ChildCloseResult {
  code: number | null
  signal: NodeJS.Signals | null
  error: Error | null
}

async function closesWithin(closed: Promise<ChildCloseResult>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<false>(resolvePromise => {
        timer = setTimeout(() => resolvePromise(false), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function stopProcessTree(child: ChildProcess, closed: Promise<ChildCloseResult>): Promise<void> {
  terminateTree(child, false)
  if (await closesWithin(closed, 3_000)) return
  terminateTree(child, true)
  if (!await closesWithin(closed, 5_000)) {
    throw new Error(`Electron 进程树未能终止（pid=${String(child.pid)}）`)
  }
}

function writeFailureArtifacts(scratch: string, stdout: string, stderr: string): string {
  const base = resolve(rootDir, process.env.CI_ARTIFACT_DIR ?? '.ci-artifacts')
  const destination = join(base, `electron-${process.platform}`)
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'stdout.log'), stdout)
  writeFileSync(join(destination, 'stderr.log'), stderr)
  const logs = join(scratch, 'electron-user-data', 'logs')
  if (existsSync(logs)) cpSync(logs, join(destination, 'app-logs'), { recursive: true })
  return destination
}

async function main(): Promise<void> {
  const requireFromDesktop = createRequire(join(desktopDir, 'package.json'))
  const electronPath = requireFromDesktop('electron') as unknown
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    throw new Error(
      'Electron binary 未安装；请先运行 pnpm --filter @dsh-desktop/desktop exec install-electron',
    )
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-electron-smoke-'))
  let stdout = ''
  let stderr = ''
  let child: ChildProcess | null = null
  let closed: Promise<ChildCloseResult> | null = null
  let passed = false
  let runError: unknown
  let cleanupError: unknown
  try {
    child = spawn(electronPath, [desktopDir], {
      cwd: rootDir,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
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
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk)
      process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk)
      process.stderr.write(chunk)
    })

    closed = new Promise<ChildCloseResult>((resolvePromise) => {
      let spawnError: Error | null = null
      child?.once('error', (error) => { spawnError = error })
      child?.once('close', (code, signal) => {
        resolvePromise({ code, signal, error: spawnError })
      })
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<{ kind: 'timeout' }>(resolvePromise => {
      timeout = setTimeout(() => resolvePromise({ kind: 'timeout' }), timeoutMs)
    })
    const outcome = await (async () => {
      try {
        return await Promise.race([
          closed.then(result => ({ kind: 'close' as const, result })),
          timedOut,
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    })()
    if (outcome.kind === 'timeout') {
      throw new Error(`Electron smoke 超时（${timeoutMs}ms）`)
    }
    if (outcome.result.error !== null) throw outcome.result.error
    if (!stdout.includes(sentinel)) {
      throw new Error(
        `Electron 在 ready sentinel 前退出（code=${String(outcome.result.code)}, signal=${String(outcome.result.signal)}）`,
      )
    }
    if (outcome.result.code !== 0 || outcome.result.signal !== null) {
      throw new Error(
        `Electron smoke 未干净退出（code=${String(outcome.result.code)}, signal=${String(outcome.result.signal)}）`,
      )
    }
    passed = true
    console.log(`[ci-smoke] Electron startup passed on ${process.platform}`)
  } catch (error) {
    runError = error
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
      const destination = writeFailureArtifacts(scratch, stdout, stderr)
      console.error(`[ci-smoke] failure artifacts: ${destination}`)
    }
    if (cleanupError === undefined) rmSync(scratch, { recursive: true, force: true })
  }
  if (runError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([runError, cleanupError], 'Electron smoke 与进程清理均失败')
  }
  if (runError !== undefined) throw runError
  if (cleanupError !== undefined) throw cleanupError
}

await main()
