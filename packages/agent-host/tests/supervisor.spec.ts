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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    await supervisor.stop()
    await expect(started).rejects.toThrow(/ready 前被停止/)
  })
})
