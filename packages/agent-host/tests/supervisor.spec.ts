import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentSupervisor, redactSecrets, type AgentSupervisorOptions } from '../src/supervisor'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function makeOptions(fixture: string, overrides: Partial<AgentSupervisorOptions> = {}): AgentSupervisorOptions {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-host-test-'))
  return {
    cliEntry: join(fixturesDir, fixture),
    dshHome: join(scratch, 'dsh-home'),
    logDir: join(scratch, 'logs'),
    ...overrides,
  }
}

function scratchDirs(options: AgentSupervisorOptions): string[] {
  return [options.dshHome, options.logDir].map((d) => dirname(d))
}

let supervisors: AgentSupervisor[] = []

function track(supervisor: AgentSupervisor): AgentSupervisor {
  supervisors.push(supervisor)
  return supervisor
}

afterEach(async () => {
  for (const s of supervisors) {
    await s.stop().catch(() => {})
    for (const dir of scratchDirs((s as unknown as { options: AgentSupervisorOptions }).options)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  supervisors = []
})

describe('AgentSupervisor', () => {
  it('脱敏 URL、CLI 与 JSON 形态的 token', () => {
    expect(redactSecrets(
      'http://127.0.0.1/?token=url-secret --launch-token cli-secret {"token":"json-secret"}',
    )).toBe(
      'http://127.0.0.1/?token=[REDACTED] --launch-token [REDACTED] {"token":"[REDACTED]"}',
    )
  })

  it('脱敏 Authorization: Bearer 头与 sk- 前缀 API key', () => {
    expect(redactSecrets(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature sk-0123456789abcdefghijklmnop',
    )).toBe(
      'Authorization: Bearer [REDACTED] sk-[REDACTED]',
    )
    // 请求头大小写不敏感；sk- 短于 16 位或前缀前有词字符的不误伤
    expect(redactSecrets('authorization: bearer abc123')).toBe('authorization: Bearer [REDACTED]')
    expect(redactSecrets('musk-explorer')).toBe('musk-explorer')
  })

  it('start 解析 ready 行，stop 终止进程', async () => {
    const options = makeOptions('fake-dsh-ready.mjs')
    const supervisor = track(new AgentSupervisor(options))

    const ready = await supervisor.start()
    expect(ready.url).toBe('http://127.0.0.1:4567/?token=test-token')
    expect(ready.port).toBe(4567)
    expect(ready.token).toBe('test-token')
    expect(ready.pid).toBeGreaterThan(0)
    expect(supervisor.state).toBe('running')
    expect(supervisor.readyInfo?.token).toBe('test-token')

    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
    expect(supervisor.readyInfo).toBeNull()

    const log = readFileSync(join(options.logDir, 'dsh-agent.log'), 'utf8')
    expect(log).toContain('booting plugins...')
    expect(log).toContain('dsh web: http://127.0.0.1:4567/?token=[REDACTED]')
    expect(log).not.toContain('test-token')
    if (process.platform !== 'win32') {
      expect(statSync(join(options.logDir, 'dsh-agent.log')).mode & 0o777).toBe(0o600)
    }
  })

  it('ready 前退出时 start 拒绝', async () => {
    const supervisor = track(new AgentSupervisor(makeOptions('fake-dsh-early-exit.mjs')))
    await expect(supervisor.start()).rejects.toThrow(/ready 前退出.*code=2/)
    expect(supervisor.state).toBe('stopped')
  })

  it('超时未 ready 时 start 拒绝', async () => {
    const supervisor = track(new AgentSupervisor(makeOptions('fake-dsh-silent.mjs', { startupTimeoutMs: 300 })))
    await expect(supervisor.start()).rejects.toThrow(/启动超时/)
  })

  it('意外退出后按策略自动重启', async () => {
    const supervisor = track(
      new AgentSupervisor(
        makeOptions('fake-dsh-crash.mjs', {
          restart: { maxRetries: 100, baseDelayMs: 50, maxDelayMs: 100 },
        }),
      ),
    )
    const restartingEvents: Array<[number, number]> = []
    supervisor.on('restarting', (attempt: number, delay: number) => {
      restartingEvents.push([attempt, delay])
    })

    await supervisor.start()
    await new Promise<void>((resolvePromise) => {
      const check = (): void => {
        if (restartingEvents.length >= 2) resolvePromise()
        else setTimeout(check, 20)
      }
      check()
    })

    expect(restartingEvents.length).toBeGreaterThanOrEqual(2)
    expect(restartingEvents[0][0]).toBe(1)
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
  })

  it('短命进程不会在 ready 时清零预算，达到上限后停止', async () => {
    const supervisor = track(
      new AgentSupervisor(
        makeOptions('fake-dsh-crash.mjs', {
          restart: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 10, stableRunMs: 5_000 },
        }),
      ),
    )
    const attempts: number[] = []
    supervisor.on('restarting', (attempt: number) => attempts.push(attempt))

    await supervisor.start()
    await new Promise<void>((resolvePromise) => supervisor.once('gave-up', resolvePromise))

    expect(attempts).toEqual([1, 2])
    expect(supervisor.state).toBe('stopped')
  })

  it('自动重启在 ready 前失败时继续退避，不触发致命 error 事件', async () => {
    const supervisor = track(
      new AgentSupervisor(
        makeOptions('fake-dsh-ready-then-early.mjs', {
          restart: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 10, stableRunMs: 5_000 },
        }),
      ),
    )
    const failures: number[] = []
    supervisor.on('restart-failed', (_error: unknown, attempt: number) => failures.push(attempt))

    await supervisor.start()
    await new Promise<void>((resolvePromise) => supervisor.once('gave-up', resolvePromise))

    expect(failures).toEqual([1, 2])
    expect(supervisor.state).toBe('stopped')
  })

  it('start 进行中调用 stop 会让 start 拒绝而非悬挂', async () => {
    const supervisor = track(new AgentSupervisor(makeOptions('fake-dsh-silent.mjs')))
    const started = supervisor.start()
    const rejected = expect(started).rejects.toThrow(/ready 前被停止/)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    await supervisor.stop()
    await rejected
  })

  it('stop 时进程无视 SIGTERM 则 SIGKILL 兜底，stop 正常返回', { timeout: 10_000 }, async () => {
    const supervisor = track(
      new AgentSupervisor(makeOptions('fake-dsh-stubborn.mjs', { stopGraceMs: 100 })),
    )

    await supervisor.start()
    expect(supervisor.state).toBe('running')

    // 优雅期 100ms 内进程不退，terminate 必须升级到 SIGKILL 并等到 close
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
    expect(supervisor.readyInfo).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('CLI exit 不等待继承管道，stop 仍升级终止同组孙进程', { timeout: 10_000 }, async () => {
    const options = makeOptions('fake-dsh-inherited-pipe.mjs', {
      stopGraceMs: 100,
      restart: { maxRetries: 0 },
    })
    const supervisor = track(new AgentSupervisor(options))
    const exited = new Promise<void>((resolveExit) => supervisor.once('exit', () => resolveExit()))
    await supervisor.start()
    await exited
    expect(supervisor.state).toBe('stopping')
    expect(supervisor.readyInfo).toBeNull()
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
  })

  it.skipIf(process.platform === 'win32')('独立进程组保留stderr时有界关闭管道并恢复监管器状态', { timeout: 12_000 }, async () => {
    const options = makeOptions('fake-dsh-inherited-pipe.mjs', { stopGraceMs: 30, restart: { maxRetries: 0 } })
    const pidFile = join(dirname(options.logDir), 'descendant.pid')
    options.env = { FAKE_DSH_DETACHED: '1', FAKE_DSH_DESCENDANT_PID: pidFile }
    const supervisor = track(new AgentSupervisor(options))
    const gaveUp = new Promise<void>((resolveDone) => supervisor.once('gave-up', () => resolveDone()))
    await supervisor.start()
    const descendant = Number(readFileSync(pidFile, 'utf8'))
    try {
      await gaveUp
      expect(supervisor.state).toBe('stopped')
      expect(supervisor.readyInfo).toBeNull()
      await supervisor.stop()
      expect(readFileSync(join(options.logDir, 'dsh-agent.log'), 'utf8')).toContain('token=[REDACTED]')
    } finally {
      try { process.kill(-descendant, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  it('cliEntry 不存在时 start 拒绝且状态回 stopped，不悬挂', async () => {
    const supervisor = track(
      new AgentSupervisor(makeOptions('fake-dsh-ready.mjs', { cliEntry: join(fixturesDir, 'missing-dsh-bin.mjs') })),
    )

    // node 自身能 spawn 成功，入口缺失表现为立即非零退出（close code=1），走 rejectBeforeReady
    await expect(supervisor.start()).rejects.toThrow(/ready 前退出/)
    expect(supervisor.state).toBe('stopped')
  })

  it('回归锁：stop 与已入队的 restart 回调竞态，stop 后绝不拉起新进程', async () => {
    const supervisor = track(
      new AgentSupervisor(
        makeOptions('fake-dsh-crash.mjs', {
          restart: { maxRetries: 3, baseDelayMs: 30, maxDelayMs: 30, stableRunMs: 60_000 },
        }),
      ),
    )
    let readyCount = 0
    supervisor.on('ready', () => {
      readyCount += 1
    })

    await supervisor.start()
    expect(readyCount).toBe(1)
    // crash fixture 在 ready 后 50ms 自退，等 close 触发的第一次 restarting（restartTimer 已挂 30ms）
    await new Promise<void>((resolvePromise) => supervisor.once('restarting', resolvePromise))
    // 立即 stop：与已入队/即将触发的 restartTimer 回调竞态
    await supervisor.stop()
    // 等 100ms（> 3×30ms 退避）：若竞态漏防，期间会再发出 ready 拉起第二个实例
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    expect(readyCount).toBe(1)
    expect(supervisor.state).toBe('stopped')
  })

  it('稳定判定边界（略低于阈值）：崩溃周期比自身退避短 → 照常累积直至 gave-up', async () => {
    const options = makeOptions('fake-dsh-crash.mjs', {
      restart: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 100, stableRunMs: 500 },
    })
    // 存活 400ms：差一点不到 500 + 100 = 600ms 阈值，预算不得清零
    options.env = { FAKE_DSH_CRASH_AFTER_MS: '400' }
    const supervisor = track(new AgentSupervisor(options))
    const attempts: number[] = []
    supervisor.on('restarting', (attempt: number) => attempts.push(attempt))

    await supervisor.start()
    await new Promise<void>((resolvePromise) => supervisor.once('gave-up', resolvePromise))

    expect(attempts).toEqual([1, 2])
    expect(supervisor.state).toBe('stopped')
  })

  it('稳定判定边界（略高于阈值）：活过自身退避期 → 视为偶发崩溃，预算清零', async () => {
    const options = makeOptions('fake-dsh-crash.mjs', {
      restart: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 100, stableRunMs: 500 },
    })
    // 存活 800ms > 600ms 阈值：每轮 close 都判定为「稳定」并清零预算。
    // 若清零失效，attempt 会爬到 3 并 gave-up，readyCount 只有 2
    options.env = { FAKE_DSH_CRASH_AFTER_MS: '800' }
    const supervisor = track(new AgentSupervisor(options))
    const attempts: number[] = []
    let readyCount = 0
    let gaveUp = false
    supervisor.on('restarting', (attempt: number) => attempts.push(attempt))
    supervisor.on('ready', () => {
      readyCount += 1
    })
    supervisor.on('gave-up', () => {
      gaveUp = true
    })

    await supervisor.start()
    await new Promise<void>((resolvePromise) => {
      const check = (): void => {
        if (readyCount >= 3) resolvePromise()
        else setTimeout(check, 20)
      }
      check()
    })
    // 等第 5 代 ready：期间第 4 代进程崩溃（800ms）后 close 判定稳定、再次清零重启。
    // 若清零失效，attempts 会爬到 [1,2,3] 并 gave-up，此轮询到超时为止——即失败
    await new Promise<void>((resolvePromise) => {
      const check = (): void => {
        if (attempts.length >= 4 && readyCount >= 5) resolvePromise()
        else setTimeout(check, 20)
      }
      check()
    })

    expect(gaveUp).toBe(false)
    expect(attempts).toEqual([1, 1, 1, 1])
    expect(supervisor.state).toBe('running')
    await supervisor.stop()
    expect(supervisor.state).toBe('stopped')
  })

  it('运行期日志跨越上限 → 轮转到 .1，当前日志继续写入', { timeout: 20_000 }, async () => {
    const options = makeOptions('fake-dsh-chatty.mjs', { maxLogBytes: 8_192, stopGraceMs: 1_000 })
    const supervisor = track(new AgentSupervisor(options))

    await supervisor.start()
    // 等 fixture 的 200 条心跳全部落盘（约 20 KiB 总量，8 KiB 阈值下必然轮转多次）
    const logPath = join(options.logDir, 'dsh-agent.log')
    await new Promise<void>((resolvePromise) => {
      const check = (): void => {
        try {
          if (readFileSync(logPath, 'utf8').includes('heartbeat line 199')) resolvePromise()
          else setTimeout(check, 20)
        } catch {
          setTimeout(check, 20)
        }
      }
      check()
    })
    await supervisor.stop()

    // .1 是最后一次轮转搬走的中间段（轮转只发生在已写满 8 KiB 时）；
    // 当前日志接续到第 199 条心跳。两份内容都必须脱敏
    const backupPath = `${logPath}.1`
    expect(existsSync(backupPath)).toBe(true)
    expect(statSync(backupPath).size).toBeGreaterThanOrEqual(8_192)
    expect(readFileSync(backupPath, 'utf8')).toContain('[chatty] heartbeat')
    expect(readFileSync(backupPath, 'utf8')).not.toContain('chatty-secret')
    expect(readFileSync(logPath, 'utf8')).toContain('heartbeat line 199')
    expect(readFileSync(logPath, 'utf8')).not.toContain('chatty-secret')
  })

  it('巨型无换行输出：按不完整行落盘且不撑爆残留缓冲，进程保持健康', { timeout: 20_000 }, async () => {
    const options = makeOptions('fake-dsh-big-line.mjs', { stopGraceMs: 1_000 })
    const supervisor = track(new AgentSupervisor(options))

    await supervisor.start()
    expect(supervisor.state).toBe('running')
    // 等第一个超限分段落盘即可 stop：残缓冲只在 close 收尾时写回，
    // 粗管道分片（如 Linux 64 KiB）下等全量 160 KiB 会死等
    const logPath = join(options.logDir, 'dsh-agent.log')
    await new Promise<void>((resolvePromise) => {
      const check = (): void => {
        try {
          if (statSync(logPath).size > 64 * 1024) resolvePromise()
          else setTimeout(check, 20)
        } catch {
          setTimeout(check, 20)
        }
      }
      check()
    })
    await supervisor.stop()

    // 默认 64 KiB 上限：同一行输出分段落盘，两个“片段”都完整可读
    const log = readFileSync(logPath, 'utf8')
    expect(log).toContain('x'.repeat(64 * 1024))
    expect(log.length).toBeGreaterThan(160 * 1024)
  })

  it('启动超时后 terminate 收尸，start 以「未等到 ready」拒绝而非悬挂', async () => {
    const supervisor = track(
      new AgentSupervisor(makeOptions('fake-dsh-no-ready.mjs', { startupTimeoutMs: 200 })),
    )

    await expect(supervisor.start()).rejects.toThrow(/未等到 ready/)
    expect(supervisor.state).toBe('stopped')
  })
})
