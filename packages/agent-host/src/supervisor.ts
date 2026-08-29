/**
 * supervisor.ts — dsh agent 子进程监管器。
 *
 * 职责：以子进程方式启动 `dsh web`（127.0.0.1 随机端口 + 启动 token），
 * 从 stdout 解析 ready 行得到可用 URL；子进程意外退出时按指数退避重启；
 * stdout/stderr 落盘到日志目录。桌面主进程通过它拿到 loadURL 目标。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { parseReadyLine, type ReadyLineInfo } from './ready-line'

/** start() 成功时返回的信息。 */
export interface AgentReadyInfo extends ReadyLineInfo {
  /** agent 子进程 pid。 */
  pid: number
}

/** 崩溃重启策略。 */
export interface RestartPolicy {
  /** 连续意外退出的最大重启次数（ready 后归零）。 */
  maxRetries: number
  /** 退避起始毫秒数。 */
  baseDelayMs: number
  /** 退避上限毫秒数。 */
  maxDelayMs: number
}

const DEFAULT_RESTART: RestartPolicy = { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 10_000 }

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

export class AgentSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private logStream: WriteStream | null = null
  private restartTimer: NodeJS.Timeout | null = null
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
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.currentState = 'stopped'
      return
    }
    this.currentState = 'stopping'
    await this.terminate(child)
    this.currentState = 'stopped'
  }

  private spawnAndWaitReady(): Promise<AgentReadyInfo> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.currentState = 'starting'
      mkdirSync(this.options.logDir, { recursive: true })
      this.logStream = createWriteStream(join(this.options.logDir, 'dsh-agent.log'), { flags: 'a' })

      const node = this.options.nodeExecutable ?? process.execPath
      const args = [
        ...(this.options.nodeArgs ?? []),
        this.options.cliEntry,
        ...(this.options.profileArgs ?? ['--profile', 'web', '--no-open', '--port', '0']),
      ]
      // 分隔行：日志以追加方式写入，多次启动的输出必须能区分开；
      // 记录完整命令行，参数类问题看一眼日志就能定位
      this.logStream.write(`\n===== dsh agent spawn ${new Date().toISOString()} =====\n$ ${node} ${args.join(' ')}\n`)

      const child = spawn(node, args, {
          env: { ...process.env, DSH_HOME: this.options.dshHome, ...this.options.env },
          // POSIX 下独立进程组，stop() 才能整组 SIGTERM/SIGKILL
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      this.child = child

      let settled = false
      let stdoutBuf = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void this.terminate(child)
        rejectPromise(new Error(`agent 启动超时（${this.options.startupTimeoutMs ?? 60_000}ms 内未等到 ready 行）`))
      }, this.options.startupTimeoutMs ?? 60_000)

      child.stdout!.on('data', (chunk: Buffer) => {
        this.logStream?.write(chunk)
        stdoutBuf += chunk.toString('utf8')
        let newlineIndex = stdoutBuf.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = stdoutBuf.slice(0, newlineIndex)
          stdoutBuf = stdoutBuf.slice(newlineIndex + 1)
          newlineIndex = stdoutBuf.indexOf('\n')
          if (settled) continue
          const ready = parseReadyLine(line)
          if (ready) {
            settled = true
            clearTimeout(timer)
            this.retryCount = 0
            this.currentState = 'running'
            this.currentReady = { ...ready, pid: child.pid ?? 0 }
            this.emit('ready', this.currentReady)
            resolvePromise(this.currentReady)
          }
        }
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        this.logStream?.write(chunk)
      })
      child.on('error', (err) => {
        this.logStream?.end()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.currentState = 'stopped'
          rejectPromise(err)
        }
      })
      child.on('exit', (code, signal) => {
        this.logStream?.end()
        this.logStream = null
        this.child = null
        this.currentReady = null
        this.emit('exit', code, signal)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.currentState = 'stopped'
          rejectPromise(
            this.intentionalStop
              ? new Error('agent 在 ready 前被停止')
              : new Error(`agent 在 ready 前退出（code=${code} signal=${signal}），日志见 ${this.options.logDir}`),
          )
          return
        }
        if (this.intentionalStop) return
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
        this.emit('error', err)
      })
    }, delay)
  }

  /** 整组 SIGTERM，超时后 SIGKILL；进程退出后 resolve。 */
  private async terminate(child: ChildProcess): Promise<void> {
    const exited = new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) resolvePromise()
      else child.once('exit', () => resolvePromise())
    })
    this.signal(child, 'SIGTERM')
    const grace = this.options.stopGraceMs ?? 5_000
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<true>((resolvePromise) => setTimeout(() => resolvePromise(true), grace)),
    ])
    if (timedOut) {
      this.signal(child, 'SIGKILL')
      await exited
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
