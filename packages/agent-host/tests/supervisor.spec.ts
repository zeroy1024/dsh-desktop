import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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

  it('cliEntry 不存在时 start 拒绝且状态回 stopped，不悬挂', async () => {
    const supervisor = track(
      new AgentSupervisor(makeOptions('fake-dsh-ready.mjs', { cliEntry: '/definitely/missing/dsh-bin.js' })),
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

  it('启动超时后 terminate 收尸，start 以「未等到 ready」拒绝而非悬挂', async () => {
    const supervisor = track(
      new AgentSupervisor(makeOptions('fake-dsh-no-ready.mjs', { startupTimeoutMs: 200 })),
    )

    await expect(supervisor.start()).rejects.toThrow(/未等到 ready/)
    expect(supervisor.state).toBe('stopped')
  })
})
