/**
 * Launch the real unpackaged Electron application and require a clean,
 * self-terminating startup. The main process emits its sentinel only after:
 *
 *   dsh ready -> WebUI mounted -> desktop plugin/preload markers verified.
 *
 * Two phases run sequentially, each with a fresh app process and DSH_HOME:
 *
 *   startup  — the plain startup contract above;
 *   restart  — same boot, then the app itself performs one restart-agent
 *              (new random port, pid record rewrite, renderer reload) and
 *              re-verifies the markers before quitting.
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
/** 重启阶段 sentinel：应用自身经 restart-agent 路径完成一代重启并回到就绪。 */
const restartSentinel = '[ci-smoke] DSH_DESKTOP_READY_AFTER_RESTART'
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

  // 每阶段一次全新进程（scratch DSH_HOME/输出/子进程都归该阶段所有）：
  // 首启阶段验证干净的冷启动；随后带 DSH_DESKTOP_CI_SMOKE_STAGE=restart
  // 再跑一次，由应用在首启就绪后经 restart-agent 路径重启 agent 并再次
  // 就绪后自行退出（allowedPort 清空、splash 重铺、pid 记录重写、渲染进程
  // 重载到新随机端口都在这一代进程里覆盖）。两次失败清理互不干扰，
  // 第二次还连带验证两个一次性预算：restart 冷却（3s）与 ready 前自愈——
  // 重启发生在首启就绪之后，距就绪远超 3s，冷却必然放行；首启成功意味着
  // 自愈预算未占用，重启一代的失败不会触发第二次重解压。
  const outcomes: string[] = []
  for (const stage of ['startup', 'restart'] as const) {
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
          // 显式钉住阶段值：'startup' 在应用侧等同未设置（仅 'restart'
          // 触发重启冒烟），防止外部环境变量把 restart 阶段泄漏进首启阶段
          DSH_DESKTOP_CI_SMOKE_STAGE: stage,
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
          `Electron 在 ready sentinel 前退出（stage=${stage}, code=${String(outcome.result.code)}, signal=${String(outcome.result.signal)}）`,
        )
      }
      if (stage === 'restart') {
        // 重启阶段必须输出两代就绪 sentinel，且重启后端口必须切换（新一轮
        // 随机端口——证明 agent 真的重启了，而不是复用旧进程）
        if (!stdout.includes(restartSentinel)) {
          throw new Error(
            `Electron 未输出 restart 阶段 sentinel（stage=${stage}, code=${String(outcome.result.code)}, signal=${String(outcome.result.signal)}）`,
          )
        }
        const portMatch = /\[ci-smoke\] DSH_DESKTOP_READY_AFTER_RESTART[^[]*?port=(\d+) \(first=(\d+)\)/u.exec(stdout)
        if (portMatch === null) {
          throw new Error('Electron restart 阶段缺少端口信息')
        }
        if (portMatch[1] === portMatch[2]) {
          throw new Error(`Electron restart 阶段端口未切换（仍为 ${portMatch[1]}）`)
        }
      }
      if (outcome.result.code !== 0 || outcome.result.signal !== null) {
        throw new Error(
          `Electron smoke 未干净退出（stage=${stage}, code=${String(outcome.result.code)}, signal=${String(outcome.result.signal)}）`,
        )
      }
      passed = true
      outcomes.push(stage)
      console.log(`[ci-smoke] Electron ${stage} passed on ${process.platform}`)
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
    if (runError !== undefined) {
      throw new AggregateError(
        [runError, ...(cleanupError !== undefined ? [cleanupError] : [])],
        `Electron smoke ${stage} 失败`,
      )
    }
    if (cleanupError !== undefined) throw cleanupError
  }
  console.log(`[ci-smoke] Electron smoke phases passed: ${outcomes.join(' -> ')}`)
}

await main()
