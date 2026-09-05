/**
 * supervisor.ts — dsh agent 子进程监管器。
 *
 * 职责：以子进程方式启动 `dsh web`（127.0.0.1 随机端口 + 启动 token），
 * 从 stdout 解析 ready 行得到可用 URL；子进程意外退出时按指数退避重启；
 * stdout/stderr 落盘到日志目录。桌面主进程通过它拿到 loadURL 目标。
 * 上游 0.1.2 起 ready 行重新携带 ?token=（首载 303 换签名 cookie）；
 * redactSecrets 对日志中的 token 做统一脱敏，ready.url 原样透传给主进程。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { parseReadyLine, type ReadyLineInfo } from './ready-line'
import { createWindowsJob, windowsJobNodeOptions, type WindowsJob } from './windows-job'

/** start() 成功时返回的信息。 */
export interface AgentReadyInfo extends ReadyLineInfo {
  /** agent 子进程 pid。 */
  pid: number
}

/** 崩溃重启策略。 */
export interface RestartPolicy {
  /** 连续意外退出的最大重启次数。 */
  maxRetries: number
  /** 退避起始毫秒数。 */
  baseDelayMs: number
  /** 退避上限毫秒数。 */
  maxDelayMs: number
  /**
   * 「稳定」判定阈值：一次意外退出前的存活时间 ≥ stableRunMs + 当期退避延迟
   * 才视为偶发崩溃并把重试次数清零——即「活过了自己当下的退避期」才算稳定。
   * 无独立计时器，以 exit 时刻计存活时间、清理完毕后判定，默认 30s。
   */
  stableRunMs: number
}

const DEFAULT_RESTART: RestartPolicy = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  stableRunMs: 30_000,
}
const LOG_FILENAME = 'dsh-agent.log'
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** 无换行残留缓冲上限：巨型行不可能撑爆主进程堆，超出部分按不完整行落盘。 */
const PARTIAL_LINE_CAP = 64 * 1024

export interface AgentSupervisorOptions {
  /** dsh CLI 入口的绝对路径（upstream/apps/cli/lib/bin.js）。 */
  cliEntry: string
  /** DSH_HOME；桌面版默认传 ~/.dsh（与命令行共用），可用环境变量覆盖。 */
  dshHome: string
  /** 日志目录（dsh-agent.log 以追加方式写入）。 */
  logDir: string
  /** 运行 CLI 的 Node 可执行文件，默认 process.execPath。 */
  nodeExecutable?: string
  /** 传给 Node 的 flags（如 web profile 的 HMR 需要 --expose-internals），默认 []。 */
  nodeArgs?: string[]
  /** Win32 pre-entry bootstrap, copied outside app.asar by the desktop package. */
  windowsJobBootstrap?: string
  /** CLI 参数，默认 ['--profile', 'web', '--no-open', '--port', '0']。 */
  profileArgs?: string[]
  /** 追加的环境变量（DSH_HOME 由 dshHome 自动注入）。 */
  env?: Record<string, string>
  /** ready 行等待超时，默认 60s。 */
  startupTimeoutMs?: number
  /** SIGTERM 后等待优雅退出的毫秒数，默认 5s，超时 SIGKILL。 */
  stopGraceMs?: number
  /** 重启策略覆盖。 */
  restart?: Partial<RestartPolicy>
  /** 单文件日志上限，默认 5 MiB；运行期跨越该值同样轮转（写路径实时判定）。 */
  maxLogBytes?: number
  /** 无换行残留缓冲上限，默认 64 KiB；超限按不完整行落盘，不参与 ready 解析。 */
  partialLineCapBytes?: number
}

/**
 * win32 进程树 `taskkill` 命令构造：纯函数，便于非 Windows 主机精确单测 argv。
 * /pid /T 常规树杀，SIGKILL 升级 /T /F；控制台窗口闪现由 execFile 的
 * windowsHide 抑制（taskkill 自身没有此类参数）。
 * 仅用于旧版本孤儿进程兼容；新启动的 Windows agent 由 Job Object 管理。
 */
export function killProcessTreeCommand(pid: number, sig: NodeJS.Signals): [string, ...string[]] {
  const force = sig === 'SIGKILL' ? ['/F'] : []
  return ['taskkill', ...force, '/pid', String(pid), '/T']
}

/**
 * 执行 taskkill 进程树终止（win32 专用；其他平台 no-op 以免误杀）。
 * fire-and-forget：taskkill 失败（如进程刚退出）由调用方的 close/探活等待兜底。
 */
export function killProcessTree(pid: number, sig: NodeJS.Signals): void {
  if (process.platform !== 'win32') return
  const [command, ...args] = killProcessTreeCommand(pid, sig)
  execFile(command, args, { timeout: 10_000, windowsHide: true }, () => {
    // taskkill 失败（如进程刚退出）由调用方的 close/探活等待兜底，这里只记日志
  })
}

export type AgentState = 'stopped' | 'starting' | 'running' | 'stopping'

/** 日志可观察性不能以泄露 launch token 为代价。 */
export function redactSecrets(value: string): string {
  return value
    .replace(/([?&]token=)[^&\s"'<>]+/giu, '$1[REDACTED]')
    .replace(/(--(?:launch-)?token(?:=|\s+))\S+/giu, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")[^"]*(")/giu, '$1[REDACTED]$2')
    .replace(/(authorization:)\s*bearer\s+\S+/giu, '$1 Bearer [REDACTED]')
    // sk- 前缀 API key（16+ 位）；日志里误伤代价低，宁可多遮
    .replace(/\bsk-[a-zA-Z0-9_]{16,}\b/gu, 'sk-[REDACTED]')
}

export class AgentSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private logStream: WriteStream | null = null
  private readonly logCloseTasks = new WeakMap<ChildProcess, Promise<void>>()
  private readonly childCloseTasks = new WeakMap<ChildProcess, Promise<void>>()
  private readonly terminationTasks = new WeakMap<ChildProcess, Promise<void>>()
  private readonly childLogStreams = new WeakMap<ChildProcess, Set<WriteStream>>()
  private readonly windowsJobs = new WeakMap<ChildProcess, WindowsJob>()
  private latestLogCloseTask: Promise<void> = Promise.resolve()
  private restartTimer: NodeJS.Timeout | null = null
  private currentState: AgentState = 'stopped'
  private currentReady: AgentReadyInfo | null = null
  private retryCount = 0
  private intentionalStop = false
  private readonly restartPolicy: RestartPolicy
  private readonly maxLogBytes: number
  private readonly partialLineCapBytes: number

  constructor(private readonly options: AgentSupervisorOptions) {
    super()
    this.restartPolicy = { ...DEFAULT_RESTART, ...options.restart }
    this.maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES
    this.partialLineCapBytes = options.partialLineCapBytes ?? PARTIAL_LINE_CAP
  }

  get state(): AgentState {
    return this.currentState
  }

  /** 最近一次 ready 的信息；未 ready 或已停止时为 null。 */
  get readyInfo(): AgentReadyInfo | null {
    return this.currentReady
  }

  /**
   * 启动 agent 并等待 ready 行。
   *
   * @returns ready 后可直接使用的 URL/端口/token/pid。
   */
  start(): Promise<AgentReadyInfo> {
    if (this.currentState !== 'stopped') {
      return Promise.reject(new Error(`agent 已在运行（state=${this.currentState}）`))
    }
    this.intentionalStop = false
    this.retryCount = 0
    return this.spawnAndWaitReady()
  }

  /** 停止 agent（不再自动重启）。进程退出后 resolve。 */
  async stop(): Promise<void> {
    this.intentionalStop = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) {
      await this.waitForCleanup(this.latestLogCloseTask, 5_000)
      this.currentState = 'stopped'
      this.currentReady = null
      return
    }
    this.currentState = 'stopping'
    await this.terminate(child)
    this.currentState = 'stopped'
    this.currentReady = null
  }

  private spawnAndWaitReady(): Promise<AgentReadyInfo> {
    return new Promise((resolvePromise, rejectPromise) => {
      // 兜底防御：restart 回调侧已检查 intentionalStop，此处再挡一层，stop 后绝不拉起新进程
      if (this.intentionalStop) {
        this.currentState = 'stopped'
        rejectPromise(new Error('agent 已停止，放弃启动'))
        return
      }
      this.currentState = 'starting'
      let job: WindowsJob | undefined
      const bootstrap = this.options.windowsJobBootstrap
        ?? fileURLToPath(new URL('../assets/windows-job-bootstrap.cjs', import.meta.url))
      let logStream: WriteStream
      try {
        if (process.platform === 'win32') {
          if (!existsSync(bootstrap)) throw new Error(`Windows job bootstrap missing: ${bootstrap}`)
          job = createWindowsJob(this.options.cliEntry)
        }
        logStream = this.openLogStream()
      } catch (error) {
        this.closeJob(job)
        this.currentState = 'stopped'
        rejectPromise(error)
        return
      }
      this.logStream = logStream
      // 运行期日志字节计数；写日志统一走 writeLog（脱敏 + 计数 + 越阈轮转同一处）
      let logBytes = 0
      // 每代进程的日志关闭承诺链：运行期轮转会中途换流，只有最后一个流的
      // close 才算这一代日志关毕，terminate()/stop() 不能提前返回
      let logCloseTask: Promise<void> = Promise.resolve()
      const openLogStreams = new Set<WriteStream>()
      const attachLogStream = (stream: WriteStream): void => {
        openLogStreams.add(stream)
        const closed = new Promise<void>((resolveLogClose) => {
          let settled = false
          const done = (): void => {
            if (settled) return
            settled = true
            openLogStreams.delete(stream)
            resolveLogClose()
          }
          stream.once('close', done)
          stream.once('error', done)
        })
        logCloseTask = logCloseTask.then(() => closed)
        this.logCloseTasks.set(child, logCloseTask)
        this.latestLogCloseTask = logCloseTask
      }
      const writeLog = (text: string, allowRotation = true): void => {
        const rendered = redactSecrets(text)
        logBytes += Buffer.byteLength(rendered, 'utf8')
        logStream.write(rendered)
        if (!allowRotation || logBytes < this.maxLogBytes) return
        // 跨过阈值：运行期中位轮转（与 spawn 时同一语义），换新流接续。
        // 磁盘文件大小是轮转基准，计数只是触发器——flush 落后时本轮跳过，
        // 计数已复位，下一轮写入自然再试
        logBytes = 0
        if (this.rotateLogIfNeeded(join(this.options.logDir, LOG_FILENAME))) {
          logStream.end()
          logStream = this.openLogStream()
          this.logStream = logStream
          attachLogStream(logStream)
        }
      }

      const node = this.options.nodeExecutable ?? process.execPath
      const args = [
        // NODE_OPTIONS runs our preload before user preloads. Keep an argv copy
        // for runtimes that disable NODE_OPTIONS; CommonJS caches the duplicate.
        ...(job === undefined ? [] : ['--require', bootstrap]),
        ...(this.options.nodeArgs ?? []),
        this.options.cliEntry,
        ...(this.options.profileArgs ?? ['--profile', 'web', '--no-open', '--port', '0']),
      ]

      let child: ChildProcess
      try {
        child = spawn(node, args, {
          env: {
            ...process.env, DSH_HOME: this.options.dshHome, ...this.options.env,
            ...(job === undefined ? {} : {
              DSH_DESKTOP_JOB_NAME: job.name,
              NODE_OPTIONS: windowsJobNodeOptions(bootstrap, this.options.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS),
            }),
          },
          // POSIX 下独立进程组，stop() 才能整组 SIGTERM/SIGKILL；
          // Windows bootstrap 在 dsh 代码前加入父进程拥有的 Job Object。
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        this.closeJob(job)
        logStream.destroy()
        this.currentState = 'stopped'
        rejectPromise(error)
        return
      }
      this.child = child
      if (job !== undefined) this.windowsJobs.set(child, job)
      this.childLogStreams.set(child, openLogStreams)
      this.childCloseTasks.set(child, new Promise<void>((resolveClose) => child.once('close', resolveClose)))
      attachLogStream(logStream)
      // 分隔行：日志以追加方式写入，多次启动的输出必须能区分开；
      // 记录完整命令行，参数类问题看一眼日志就能定位
      writeLog(`\n===== dsh agent spawn ${new Date().toISOString()} =====\n$ ${node} ${args.join(' ')}\n`)

      let promiseSettled = false
      let reachedReady = false
      // ready 行到达时刻：与 exit 时刻相减判定稳定，不计清理耗时。
      let readyAt = 0
      let startupFailure: Error | null = null
      let stdoutBuf = ''
      let stderrBuf = ''
      // 多字节 UTF-8 字符可能跨 chunk 边界，直接 toString 会截断成 replacement char；
      // StringDecoder 扣留残缺的尾部字节，等后续 chunk 补全再输出
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      const writeCompleteLines = (decoder: StringDecoder, chunk: Buffer, current: string, onLine?: (line: string) => void): string => {
        let buffer = current + decoder.write(chunk)
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          writeLog(`${line}\n`)
          onLine?.(line)
          newlineIndex = buffer.indexOf('\n')
        }
        // 巨型无换行输出不能让残留缓冲无限增长：ready 后按不完整行落盘并丢弃。
        // ready 前绝不触发——ready 行只从完整行解析，启动期输出量小用不到
        if (reachedReady && buffer.length > this.partialLineCapBytes) {
          writeLog(`${buffer}\n`)
          buffer = ''
        }
        return buffer
      }
      const rejectBeforeReady = (error: Error): void => {
        if (promiseSettled) return
        promiseSettled = true
        clearTimeout(timer)
        this.currentState = 'stopped'
        rejectPromise(error)
      }
      const timer = setTimeout(() => {
        if (promiseSettled) return
        startupFailure = new Error(`agent 启动超时（${this.options.startupTimeoutMs ?? 60_000}ms 内未等到 ready 行）`)
        this.currentState = 'stopping'
        // 等 close 后再拒绝，保证自动重试不会与尚在退出的旧进程重叠。
        // SIGKILL 都收不掉尸的极端路径：记录并显式拒绝，start() 不能悬挂。
        void this.terminate(child).catch((error: unknown) => {
          console.error('[agent] 启动超时后终止失败', error)
          rejectBeforeReady(error instanceof Error ? error : new Error(String(error)))
        })
      }, this.options.startupTimeoutMs ?? 60_000)

      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuf = writeCompleteLines(stdoutDecoder, chunk, stdoutBuf, (line) => {
          if (promiseSettled || startupFailure !== null) return
          const ready = parseReadyLine(line)
          if (ready) {
            promiseSettled = true
            reachedReady = true
            readyAt = Date.now()
            clearTimeout(timer)
            this.currentState = 'running'
            this.currentReady = { ...ready, pid: child.pid ?? 0 }
            this.emit('ready', this.currentReady)
            resolvePromise(this.currentReady)
          }
        })
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBuf = writeCompleteLines(stderrDecoder, chunk, stderrBuf)
      })
      child.on('error', (err) => {
        if (!reachedReady) startupFailure = err
      })
      let exitObserved = false
      const observeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exitObserved) return
        exitObserved = true
        this.closeJob(this.windowsJobs.get(child))
        const exitedAt = Date.now()
        clearTimeout(timer)
        if (this.child === child) {
          this.currentReady = null
          this.currentState = 'stopping'
        }
        // A descendant may retain stdout/stderr after the CLI exits. Invalidate
        // transport immediately, then finish bounded pipe/tree cleanup before
        // starting another generation.
        this.emit('exit', code, signal)
        void this.terminate(child).catch((error: unknown) => {
          console.warn('[agent] 退出后清理失败', error)
        }).then(() => {
          if (this.child !== child) return
          this.child = null
          if (!reachedReady) {
            rejectBeforeReady(
              this.intentionalStop
                ? new Error('agent 在 ready 前被停止')
                : startupFailure
                  ?? new Error(`agent 在 ready 前退出（code=${code} signal=${signal}），日志见 ${this.options.logDir}`),
            )
            return
          }
          if (this.intentionalStop) {
            this.currentState = 'stopped'
            return
          }
          const expectedDelay = Math.min(
            this.restartPolicy.baseDelayMs * 2 ** this.retryCount,
            this.restartPolicy.maxDelayMs,
          )
          if (exitedAt - readyAt >= this.restartPolicy.stableRunMs + expectedDelay) {
            this.retryCount = 0
          }
          this.scheduleRestart()
        })
      }
      child.once('exit', observeExit)
      child.on('close', (code, signal) => {
        // decoder.end() 吐出跨 chunk 扣留的尾部字节，拼在行缓冲之后一并落盘；
        // 收尾写入不再轮转（下一次 spawn 的 openLogStream 会做同样的轮转）
        const stdoutTail = stdoutBuf + stdoutDecoder.end()
        const stderrTail = stderrBuf + stderrDecoder.end()
        if (stdoutTail.length > 0) writeLog(stdoutTail, false)
        if (stderrTail.length > 0) writeLog(stderrTail, false)
        logStream.end()
        if (this.logStream === logStream) this.logStream = null
        // A spawn error emits close without exit.
        observeExit(code, signal)
      })
    })
  }

  private scheduleRestart(): void {
    if (this.retryCount >= this.restartPolicy.maxRetries) {
      this.currentState = 'stopped'
      this.emit('gave-up', this.retryCount)
      return
    }
    const delay = Math.min(
      this.restartPolicy.baseDelayMs * 2 ** this.retryCount,
      this.restartPolicy.maxDelayMs,
    )
    this.retryCount += 1
    this.currentState = 'starting'
    this.emit('restarting', this.retryCount, delay)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      // stop() 与本回调的入队竞态：clearTimeout 对已入队的回调无效，
      // 此时 stop 已把 intentionalStop 置位，直接放弃，不能再拉起新进程。
      if (this.intentionalStop) return
      this.spawnAndWaitReady().catch((err: unknown) => {
        if (this.intentionalStop) return
        this.emit('restart-failed', err, this.retryCount)
        this.scheduleRestart()
      })
    }, delay)
  }

  /**
   * 当前日志文件 ≥ maxLogBytes 时轮转到 .1（与 spawn 时同一语义，运行期共用）。
   *
   * @returns 是否发生了轮转。
   */
  private rotateLogIfNeeded(logPath: string): boolean {
    try {
      if (!existsSync(logPath) || statSync(logPath).size < this.maxLogBytes) return false
      const backupPath = `${logPath}.1`
      rmSync(backupPath, { force: true })
      renameSync(logPath, backupPath)
      chmodSync(backupPath, 0o600)
      return true
    } catch {
      // 轮转失败不能阻断 agent；仍尝试追加当前日志。
      return false
    }
  }

  private openLogStream(): WriteStream {
    mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 })
    const logPath = join(this.options.logDir, LOG_FILENAME)
    this.rotateLogIfNeeded(logPath)
    const stream = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    stream.on('error', (error) => {
      console.warn(`[agent] 无法写入日志 ${logPath}`, error)
    })
    stream.once('open', () => {
      try {
        chmodSync(logPath, 0o600)
      } catch {
        // 权限收紧失败由宿主文件系统决定，不阻断启动。
      }
    })
    return stream
  }

  /**
   * 整组 SIGTERM，超时后 SIGKILL；stdio 已关闭并完成清场后 resolve。
   * win32：关闭父进程持有的 Job handle，立即终止本代 agent 的进程树。
   */
  private terminate(child: ChildProcess): Promise<void> {
    const existing = this.terminationTasks.get(child)
    if (existing !== undefined) return existing
    const task = this.terminateChild(child)
    this.terminationTasks.set(child, task)
    return task
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    // exitCode/signalCode describe exit, never pipe closure. This promise is
    // installed at spawn so exit-before-stop cannot miss the close event.
    const closed = this.childCloseTasks.get(child)!
    this.signal(child, 'SIGTERM')
    const grace = this.options.stopGraceMs ?? 5_000
    let graceTimer: NodeJS.Timeout | undefined
    const graceElapsed = new Promise<true>((resolvePromise) => {
      graceTimer = setTimeout(() => resolvePromise(true), grace)
    })
    const timedOut = await (async () => {
      try {
        return await Promise.race([closed.then(() => false), graceElapsed])
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer)
      }
    })()
    if (timedOut) {
      this.signal(child, 'SIGKILL')
      let forceTimer: NodeJS.Timeout | undefined
      const forcedClosed = await (async () => {
        try {
          return await Promise.race([
            closed.then(() => true),
            new Promise<false>((resolvePromise) => {
              forceTimer = setTimeout(() => resolvePromise(false), 5_000)
            }),
          ])
        } finally {
          if (forceTimer !== undefined) clearTimeout(forceTimer)
        }
      })()
      if (!forcedClosed) {
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error(`agent SIGKILL 后 5000ms 内未退出（pid=${String(child.pid)}）`)
        }
        // Detached tools may outlive their CLI and retain inherited pipes.
        // The CLI is confirmed dead; release our pipe handles rather than
        // waiting forever for an unrelated process group to close them.
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (!await this.waitForCleanup(closed, 1_000)) {
          throw new Error(`agent 日志管道未关闭（pid=${String(child.pid)}）`)
        }
      }
    }
    if (!await this.waitForCleanup(this.logCloseTasks.get(child) ?? Promise.resolve(), 5_000)) {
      for (const stream of this.childLogStreams.get(child) ?? []) stream.destroy()
      throw new Error(`agent 日志落盘超时（pid=${String(child.pid)}）`)
    }
  }

  private async waitForCleanup(task: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        task.then(() => true),
        new Promise<false>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    const pid = child.pid
    try {
      if (process.platform !== 'win32' && pid !== undefined) {
        // 子进程 detached 为独立进程组，负 pid 整组发信号
        process.kill(-pid, sig)
        return
      }
      if (process.platform === 'win32' && pid !== undefined) {
        // Closing our sole lasting handle kills the complete job, including
        // detached grandchildren. child.kill also stops a pre-bootstrap child.
        this.closeJob(this.windowsJobs.get(child))
        child.kill(sig)
        return
      }
      child.kill(sig)
    } catch {
      // 进程已退出时 kill 会抛 ESRCH，忽略
      try {
        child.kill(sig)
      } catch {
        // 同上
      }
    }
  }

  private closeJob(job: WindowsJob | undefined): void {
    try {
      job?.close()
    } catch (error) {
      console.error('[agent] Windows Job Object 关闭失败', error)
    }
  }
}
