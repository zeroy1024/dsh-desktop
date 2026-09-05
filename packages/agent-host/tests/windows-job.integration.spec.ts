import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AgentSupervisor, killProcessTree } from '../src/supervisor'

const fixture = fileURLToPath(new URL('./fixtures/windows-job-tree.mjs', import.meta.url))
const ownerFixture = fileURLToPath(new URL('./fixtures/windows-job-owner.mjs', import.meta.url))
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
function pids(path: string): number[] {
  try { return JSON.parse(readFileSync(path, 'utf8')) as number[] } catch { return [] }
}
function cleanup(path: string): void {
  for (const pid of pids(path)) {
    if (alive(pid)) {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true }) } catch { /* fixture already exited */ }
    }
  }
}

// These tests use actual kernel Jobs, real detached grandchildren and the shipped
// bootstrap. Non-Windows skips are a validation gap, not simulated native proof.
describe.skipIf(process.platform !== 'win32')('real Windows Job process lifetime', () => {
  it('still reaps an uncontained legacy tree through the real taskkill command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-windows-legacy-'))
    const record = join(root, 'pids.json')
    let child: ChildProcess | undefined
    try {
      child = spawn(process.execPath, [fixture], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, DSH_TEST_JOB_PIDS: record },
      })
      await expect.poll(() => pids(record).length, { timeout: 8_000 }).toBe(3)
      expect(pids(record).every(alive)).toBe(true)
      killProcessTree(child.pid!, 'SIGKILL')
      await expect.poll(() => pids(record).some(alive), { timeout: 5_000 }).toBe(false)
    } finally {
      cleanup(record)
      child?.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['stop', 'cli-exit'])('kills detached descendants on %s', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-windows-job-'))
    const record = join(root, 'pids.json')
    const supervisor = new AgentSupervisor({
      cliEntry: fixture, dshHome: join(root, 'home'), logDir: join(root, 'logs'),
      env: { DSH_TEST_JOB_PIDS: record, DSH_TEST_JOB_EXIT: mode === 'cli-exit' ? '1' : '0' },
      restart: { maxRetries: 0 },
    })
    try {
      await supervisor.start()
      expect(pids(record)).toHaveLength(3)
      expect(pids(record).every(alive)).toBe(true)
      if (mode === 'stop') await supervisor.stop()
      await expect.poll(() => pids(record).some(alive), { timeout: 5_000 }).toBe(false)
    } finally {
      await supervisor.stop().catch(() => {})
      cleanup(record)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets the kernel kill the tree when the Job owner is force-killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-windows-owner-'))
    const record = join(root, 'pids.json')
    let owner: ChildProcess | undefined
    try {
      owner = spawn(process.execPath, [ownerFixture], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, DSH_TEST_JOB_PIDS: record },
      })
      await expect.poll(() => pids(record).length, { timeout: 8_000 }).toBe(3)
      expect(pids(record).every(alive)).toBe(true)
      owner.kill('SIGKILL')
      await expect.poll(() => pids(record).some(alive), { timeout: 5_000 }).toBe(false)
    } finally {
      owner?.kill('SIGKILL')
      cleanup(record)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
