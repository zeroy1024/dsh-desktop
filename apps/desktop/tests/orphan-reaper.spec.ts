import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readAgentPidRecord,
  reapOrphanedAgent,
  removeAgentPidRecord,
  writeAgentPidRecord,
  type ReapDeps,
} from '../src/main/orphan-reaper'
import { killProcessTreeCommand } from '@dsh-desktop/agent-host'

const CLI_ENTRY = '/vendor/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js'
const AGENT_CMDLINE = `/Electron --expose-internals ${CLI_ENTRY} --profile desktop --no-open --port 0`
const PID = 4321

interface KillCall {
  pid: number
  group: boolean
  sig: string
}

/** fake deps：probe 的行为由测试注入；kill/sleep/log 只记录不执行。 */
function makeDeps(probe: (pid: number) => Promise<string | null>): {
  deps: ReapDeps
  kills: KillCall[]
  sleeps: number[]
  logs: string[]
} {
  const kills: KillCall[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  const deps: ReapDeps = {
    probeCmdline: probe,
    kill: (pid, group, sig) => {
      kills.push({ pid, group, sig })
    },
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    log: (msg) => {
      logs.push(msg)
    },
  }
  return { deps, kills, sleeps, logs }
}

let workDir = ''
let pidPath = ''

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dsh-orphan-reaper-test-'))
  pidPath = join(workDir, 'dsh-agent.pid.json')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('reapOrphanedAgent', () => {
  it('升级首启按记录的旧版本核身，无需新版本运行时存在', async () => {
    const runtimeRoot = join(workDir, 'dsh-runtime')
    const oldEntry = join(runtimeRoot, '0.0.7', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: oldEntry })
    let probed = false
    const { deps, kills } = makeDeps(() => {
      const result = probed ? null : `/Electron --expose-internals "${oldEntry}" --profile desktop --no-open --port 0`
      probed = true
      return Promise.resolve(result)
    })
    expect(existsSync(runtimeRoot)).toBe(false)
    expect(await reapOrphanedAgent(pidPath, { runtimeRoot }, deps)).toBe('reaped')
    expect(kills).toEqual([{ pid: PID, group: true, sig: 'SIGTERM' }])
  })

  it('拒绝托管根目录之外的入口，即使命令行与记录完全一致', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    const { deps, kills } = makeDeps(() => Promise.resolve(AGENT_CMDLINE))
    expect(await reapOrphanedAgent(pidPath, { runtimeRoot: join(workDir, 'dsh-runtime') }, deps)).toBe('skipped')
    expect(kills).toHaveLength(0)
  })

  it.each([
    `/Electron ${CLI_ENTRY}.backup --profile desktop`,
    `/Electron ${CLI_ENTRY} --profile web`,
    `/Electron /prefix${CLI_ENTRY} --profile desktop`,
  ])('不把入口前缀匹配或其他 profile 当成托管 agent：%s', async (command) => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    const { deps, kills } = makeDeps(() => Promise.resolve(command))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('skipped')
    expect(kills).toHaveLength(0)
  })

  it('等待退出期间 pid 身份改变时不再发送 SIGKILL', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    let calls = 0
    const { deps, kills } = makeDeps(() => Promise.resolve(calls++ === 0 ? AGENT_CMDLINE : '/usr/bin/other-service'))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('skipped')
    expect(kills).toEqual([{ pid: PID, group: true, sig: 'SIGTERM' }])
  })

  it('无 pid 文件 → none，零 kill', async () => {
    const { deps, kills } = makeDeps(() => Promise.resolve(AGENT_CMDLINE))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('none')
    expect(kills).toHaveLength(0)
  })

  it('坏 JSON 文件 → none，零 kill', async () => {
    writeFileSync(pidPath, '{not json')
    const { deps, kills } = makeDeps(() => Promise.resolve(AGENT_CMDLINE))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('none')
    expect(kills).toHaveLength(0)
  })

  it('进程已死（probe 返回 null）→ 删文件、none、零 kill', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    const { deps, kills } = makeDeps(() => Promise.resolve(null))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('none')
    expect(kills).toHaveLength(0)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('pid 被复用（命令行不含 cliEntry）→ 删文件、skipped、绝不发信号', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    const { deps, kills } = makeDeps(() => Promise.resolve('/usr/sbin/sshd -D'))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('skipped')
    // 核心安全性质：核身失败时一次 kill 都不允许发生
    expect(kills).toHaveLength(0)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('正常收割：SIGTERM 后进程在 2s 内死去 → reaped，无 SIGKILL', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    let probed = 0
    const { deps, kills } = makeDeps(() => {
      probed += 1
      // 首次探活用于核身；SIGTERM 后的探活返回 null（已退出）
      return Promise.resolve(probed === 1 ? AGENT_CMDLINE : null)
    })
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('reaped')
    expect(kills).toEqual([{ pid: PID, group: true, sig: 'SIGTERM' }])
    expect(existsSync(pidPath)).toBe(false)
  })

  it('顽固进程：SIGTERM 后 2s 仍活 → 补整组 SIGKILL', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    const { deps, kills, sleeps } = makeDeps(() => Promise.resolve(AGENT_CMDLINE))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('reaped')
    expect(kills).toEqual([
      { pid: PID, group: true, sig: 'SIGTERM' },
      { pid: PID, group: true, sig: 'SIGKILL' },
    ])
    // 200ms × 10 次探活 = 2s 预算耗尽才升级到 SIGKILL
    expect(sleeps).toHaveLength(10)
    expect(sleeps.every((ms) => ms === 200)).toBe(true)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('探测抛异常 → skipped 且不删文件（留待下次核身）', async () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    const { deps, kills } = makeDeps(() => Promise.reject(new Error('ps failed')))
    expect(await reapOrphanedAgent(pidPath, { cliEntry: CLI_ENTRY }, deps)).toBe('skipped')
    expect(kills).toHaveLength(0)
    expect(existsSync(pidPath)).toBe(true)
  })

  it('win32 进程树 kill 命令形态：SIGTERM 常规 /T，SIGKILL 升级 /T /F', () => {
    // 旧版孤儿清理的 taskkill 构造（win32 分支），非 Windows 主机也能
    // 精确断言 argv——单 pid 的 TerminateProcess 会漏掉 dsh 的孙进程（工具执行/终端）
    expect(killProcessTreeCommand(4321, 'SIGTERM'))
      .toEqual(['taskkill', '/pid', '4321', '/T'])
    expect(killProcessTreeCommand(4321, 'SIGKILL'))
      .toEqual(['taskkill', '/F', '/pid', '4321', '/T'])
  })
})

describe('pid 记录读写', () => {
  it('write → read 往返一致', () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    expect(readAgentPidRecord(pidPath)).toEqual({ pid: PID, cliEntry: CLI_ENTRY })
  })

  it('字段非法的记录视为无记录', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 'not-a-number', cliEntry: CLI_ENTRY }))
    expect(readAgentPidRecord(pidPath)).toBeNull()
    writeFileSync(pidPath, JSON.stringify({ pid: PID }))
    expect(readAgentPidRecord(pidPath)).toBeNull()
    writeFileSync(pidPath, JSON.stringify(null))
    expect(readAgentPidRecord(pidPath)).toBeNull()
  })

  it('remove 仅在 pid 匹配时删除', () => {
    writeAgentPidRecord(pidPath, { pid: PID, cliEntry: CLI_ENTRY })
    removeAgentPidRecord(pidPath, PID + 1)
    expect(existsSync(pidPath)).toBe(true)
    removeAgentPidRecord(pidPath, PID)
    expect(existsSync(pidPath)).toBe(false)
  })
})
