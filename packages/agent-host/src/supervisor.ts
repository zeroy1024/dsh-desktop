/**
 * supervisor.ts — dsh agent 子进程监管器。
 *
 * 职责：以子进程方式启动 `dsh web`（127.0.0.1 随机端口 + 启动 token），
 * 从 stdout 解析 ready 行得到可用 URL；子进程意外退出时按指数退避重启；
 * stdout/stderr 落盘到日志目录。桌面主进程通过它拿到 loadURL 目标。
 */
import { spawn, type ChildProcess } from 'node:child_process'
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
import { parseReadyLine, type ReadyLineInfo } from './ready-line'

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
  /** 连续运行多久才视为稳定并清零重试次数，默认 30s。 */
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
}

export type AgentState = 'stopped' | 'starting' | 'running' | 'stopping'

/** 日志可观察性不能以泄露 launch token 为代价。 */
export function redactSecrets(value: string): string {
  return value
    .replace(/([?&]token=)[^&\s"'<>]+/giu, '$1[REDACTED]')
    .replace(/(--(?:launch-)?token(?:=|\s+))\S+/giu, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")[^"]*(")/giu, '$1[REDACTED]$2')
}

export class AgentSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private logStream: WriteStream | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private currentState: AgentState = 'stopped'
  private currentReady: AgentReadyInfo | null = null
  private retryCount = 0
  private intentionalStop = false
  private readonly restartPolicy: RestartPolicy

  constructor(private readonly options: AgentSupervisorOptions) {
    super()
    this.restartPolicy = { ...DEFAULT_RESTART, ...options.restart }
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
    this.clearStableTimer()
    const child = this.child
    if (!child) {
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
      this.currentState = 'starting'
      const logStream = this.openLogStream()
      this.logStream = logStream

      const node = this.options.nodeExecutable ?? process.execPath
      const args = [
        ...(this.options.nodeArgs ?? []),
        this.options.cliEntry,
        ...(this.options.profileArgs ?? ['--profile', 'web', '--no-open', '--port', '0']),
      ]
      // 分隔行：日志以追加方式写入，多次启动的输出必须能区分开；
      // 记录完整命令行，参数类问题看一眼日志就能定位
      logStream.write(redactSecrets(
        `\n===== dsh agent spawn ${new Date().toISOString()} =====\n$ ${node} ${args.join(' ')}\n`,
      ))

      const child = spawn(node, args, {
          env: { ...process.env, DSH_HOME: this.options.dshHome, ...this.options.env },
          // POSIX 下独立进程组，stop() 才能整组 SIGTERM/SIGKILL
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      this.child = child

      let promiseSettled = false
      let reachedReady = false
      let startupFailure: Error | null = null
      let stdoutBuf = ''
      let stderrBuf = ''
      const writeCompleteLines = (chunk: Buffer, current: string, onLine?: (line: string) => void): string => {
        let buffer = current + chunk.toString('utf8')
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          logStream.write(`${redactSecrets(line)}\n`)
          onLine?.(line)
          newlineIndex = buffer.indexOf('\n')
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
        void this.terminate(child)
      }, this.options.startupTimeoutMs ?? 60_000)

      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuf = writeCompleteLines(chunk, stdoutBuf, (line) => {
          if (promiseSettled || startupFailure !== null) return
          const ready = parseReadyLine(line)
          if (ready) {
            promiseSettled = true
            reachedReady = true
            clearTimeout(timer)
            this.currentState = 'running'
            this.currentReady = { ...ready, pid: child.pid ?? 0 }
            this.armStableTimer(child)
            this.emit('ready', this.currentReady)
            resolvePromise(this.currentReady)
          }
        })
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBuf = writeCompleteLines(chunk, stderrBuf)
      })
      child.on('error', (err) => {
        if (!reachedReady) startupFailure = err
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const isCurrentChild = this.child === child
        if (isCurrentChild) this.clearStableTimer()
        if (stdoutBuf.length > 0) logStream.write(redactSecrets(stdoutBuf))
        if (stderrBuf.length > 0) logStream.write(redactSecrets(stderrBuf))
        logStream.end()
        if (this.logStream === logStream) this.logStream = null
        if (isCurrentChild) {
          this.child = null
          this.currentReady = null
        }
        this.emit('exit', code, signal)
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
        this.scheduleRestart()
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
      this.spawnAndWaitReady().catch((err: unknown) => {
        if (this.intentionalStop) return
        this.emit('restart-failed', err, this.retryCount)
        this.scheduleRestart()
      })
    }, delay)
  }

  private armStableTimer(child: ChildProcess): void {
    this.clearStableTimer()
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null
      if (this.child === child && this.currentState === 'running') this.retryCount = 0
    }, this.restartPolicy.stableRunMs)
  }

  private clearStableTimer(): void {
    if (this.stableTimer === null) return
    clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private openLogStream(): WriteStream {
    mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 })
    const logPath = join(this.options.logDir, LOG_FILENAME)
    try {
      if (existsSync(logPath) && statSync(logPath).size >= MAX_LOG_BYTES) {
        const backupPath = `${logPath}.1`
        rmSync(backupPath, { force: true })
        renameSync(logPath, backupPath)
        chmodSync(backupPath, 0o600)
      }
    } catch {
      // 轮转失败不能阻断 agent；仍尝试追加当前日志。
    }
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

  /** 整组 SIGTERM，超时后 SIGKILL；stdio 已关闭并完成清场后 resolve。 */
  private async terminate(child: ChildProcess): Promise<void> {
    const closed = new Promise<void>((resolvePromise) => {
      child.once('close', () => resolvePromise())
    })
    this.signal(child, 'SIGTERM')
    const grace = this.options.stopGraceMs ?? 5_000
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise<true>((resolvePromise) => setTimeout(() => resolvePromise(true), grace)),
    ])
    if (timedOut) {
      this.signal(child, 'SIGKILL')
      await closed
    }
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        // 子进程 detached 为独立进程组，负 pid 整组发信号
        process.kill(-child.pid, sig)
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
}
