import koffi from 'koffi'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { openWindowsJob } from '../src/windows-job'

function api(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const methods = {
    CreateJobObjectW: vi.fn(() => 17n), SetInformationJobObject: vi.fn(() => 1),
    CloseHandle: vi.fn(() => 1), GetLastError: vi.fn(() => 0),
    OpenJobObjectW: vi.fn(() => 18n), AssignProcessToJobObject: vi.fn(() => 1),
    GetCurrentProcess: vi.fn(() => -1n), ...overrides,
  }
  const native = {
    ...koffi,
    load: vi.fn(() => ({ func: (_abi: string, name: keyof typeof methods) => methods[name] })),
  } as unknown as typeof koffi
  return { native, methods }
}

describe('Windows Job handle ownership (native API doubles, real Koffi layout)', () => {
  it('sets only kill-on-close, creates a non-inheritable handle and closes it once', () => {
    const { native, methods } = api()
    const job = openWindowsJob(native)
    expect(job.name).toMatch(/^Local\\dsh-desktop-[0-9a-f-]{36}$/u)
    expect(methods.CreateJobObjectW).toHaveBeenCalledWith(null, job.name)
    const [handle, informationClass, data, length] = methods.SetInformationJobObject.mock.calls[0] as unknown as [bigint, number, Buffer, number]
    expect(handle).toBe(17n)
    expect(informationClass).toBe(9)
    expect(length).toBe(process.arch === 'ia32' ? 112 : 144)
    expect(data.readUInt32LE(16)).toBe(0x2000)
    expect(data.filter((byte, index) => index !== 17 && byte !== 0)).toHaveLength(0)
    job.close()
    job.close()
    expect(methods.CloseHandle).toHaveBeenCalledExactlyOnceWith(17n)
  })

  it('fails before spawning on native creation or configuration failure', () => {
    const missing = api({ CreateJobObjectW: vi.fn(() => null), GetLastError: vi.fn(() => 5) })
    expect(() => openWindowsJob(missing.native)).toThrow('CreateJobObjectW failed (5)')
    expect(missing.methods.CloseHandle).not.toHaveBeenCalled()
    const denied = api({ SetInformationJobObject: vi.fn(() => 0), GetLastError: vi.fn(() => 5) })
    expect(() => openWindowsJob(denied.native)).toThrow('SetInformationJobObject failed (5)')
    expect(denied.methods.CloseHandle).toHaveBeenCalledExactlyOnceWith(17n)
  })

  it('does not configure an existing named job and reports a failed close', () => {
    const collision = api({ GetLastError: vi.fn(() => 183) })
    expect(() => openWindowsJob(collision.native)).toThrow('existing job')
    expect(collision.methods.SetInformationJobObject).not.toHaveBeenCalled()
    expect(collision.methods.CloseHandle).toHaveBeenCalledOnce()
    const failing = api()
    const job = openWindowsJob(failing.native)
    failing.methods.CloseHandle.mockReturnValueOnce(0)
    expect(() => job.close()).toThrow('CloseHandle(job) failed')
    expect(() => job.close()).not.toThrow()
    expect(failing.methods.CloseHandle).toHaveBeenCalledTimes(2)
  })
})

const bootstrap = readFileSync(new URL('../assets/windows-job-bootstrap.cjs', import.meta.url), 'utf8')
const jobName = 'Local\\dsh-desktop-12345678-1234-1234-1234-123456789abc'
function bootstrapHost(options: { env?: Record<string, string>; mainThread?: boolean; native?: typeof koffi } = {}) {
  const env = options.env ?? { DSH_DESKTOP_JOB_NAME: jobName }
  const native = options.native ?? api().native
  const requireFromCli = vi.fn(() => native)
  const createRequire = vi.fn(() => requireFromCli)
  return {
    env, createRequire, requireFromCli,
    run: () => runInNewContext(bootstrap, {
      process: { platform: 'win32', env, argv: ['node', '/fixture/cli.mjs'] },
      require: (id: string) => id === 'node:worker_threads'
        ? { isMainThread: options.mainThread ?? true }
        : { createRequire },
    }),
  }
}

describe('pre-entry Job assignment (native API doubles)', () => {
  it('opens only assignment access, assigns the current process and closes its temporary handle', () => {
    const { native, methods } = api()
    const host = bootstrapHost({ native })
    host.run()
    expect(host.createRequire).toHaveBeenCalledWith('/fixture/cli.mjs')
    expect(host.requireFromCli).toHaveBeenCalledWith('koffi')
    expect(methods.OpenJobObjectW).toHaveBeenCalledWith(1, 0, jobName)
    expect(methods.AssignProcessToJobObject).toHaveBeenCalledWith(18n, -1n)
    expect(methods.CloseHandle).toHaveBeenCalledExactlyOnceWith(18n)
    expect(host.env).toEqual({})
  })

  it('blocks dsh entry when the parent job disappeared or assignment fails', () => {
    const gone = api({ OpenJobObjectW: vi.fn(() => null), GetLastError: vi.fn(() => 2) })
    expect(bootstrapHost({ native: gone.native }).run).toThrow('OpenJobObjectW failed (2)')
    expect(gone.methods.AssignProcessToJobObject).not.toHaveBeenCalled()
    const denied = api({ AssignProcessToJobObject: vi.fn(() => 0), GetLastError: vi.fn(() => 5) })
    expect(bootstrapHost({ native: denied.native }).run).toThrow('AssignProcessToJobObject failed (5)')
    expect(denied.methods.CloseHandle).toHaveBeenCalledExactlyOnceWith(18n)
  })

  it('rejects invalid parent metadata and skips inherited preloads in forks and workers', () => {
    expect(bootstrapHost({ env: { DSH_DESKTOP_JOB_NAME: 'unrelated-job' } }).run).toThrow('invalid desktop job name')
    for (const host of [
      bootstrapHost({ env: {} }),
      bootstrapHost({ env: {}, mainThread: false }),
    ]) {
      host.run()
      expect(host.createRequire).not.toHaveBeenCalled()
    }
  })
})
