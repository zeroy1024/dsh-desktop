import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type koffi from 'koffi'

export interface WindowsJob {
  readonly name: string
  close(): void
}

/** Node parses double-quoted NODE_OPTIONS paths; put our require before user preloads. */
export function windowsJobNodeOptions(bootstrap: string, inherited = ''): string {
  const path = bootstrap.replaceAll('\\', '/').replaceAll('"', '\\"')
  return `--require "${path}"${inherited.trim() === '' ? '' : ` ${inherited}`}`
}

/**
 * The parent owns the only lasting handle. Windows closes it even if Electron
 * crashes or is force-killed, terminating every process in this job hierarchy.
 * This contains CreateProcess descendants, not processes started by an external
 * broker (for example WMI); it is process lifetime management, not a sandbox.
 * https://learn.microsoft.com/windows/win32/procthread/job-objects
 */
export function createWindowsJob(cliEntry: string): WindowsJob {
  const native = createRequire(cliEntry)('koffi') as typeof koffi
  return openWindowsJob(native)
}

/** Separate the native boundary so failure paths can also be tested off Windows. */
export function openWindowsJob(native: typeof koffi): WindowsJob {
  const kernel = native.load('kernel32.dll')
  const create = kernel.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'str16'])
  const configure = kernel.func('__stdcall', 'SetInformationJobObject', 'int', ['void *', 'int', 'void *', 'uint32'])
  const closeHandle = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
  // Anonymous type definitions avoid global FFI type-name collisions on restart.
  const basic = native.struct({
    PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr', PriorityClass: 'uint32', SchedulingClass: 'uint32',
  })
  const io = native.struct({
    ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
  })
  const extended = native.struct({
    BasicLimitInformation: basic, IoInfo: io,
    ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t',
  })
  // Owned V8 memory only: no koffi.view / external ArrayBuffer in Electron.
  const limits = Buffer.alloc(native.sizeof(extended))
  limits.writeUInt32LE(0x2000, native.offsetof(extended, 'BasicLimitInformation') + native.offsetof(basic, 'LimitFlags'))
  const name = `Local\\dsh-desktop-${randomUUID()}`
  // NULL security attributes make the handle non-inheritable.
  const handle = create(null, name)
  if (handle === null) throw new Error(`CreateJobObjectW failed (${String(lastError())})`)
  try {
    if (lastError() === 183) throw new Error('CreateJobObjectW unexpectedly opened an existing job')
    // JobObjectExtendedLimitInformation = 9; no breakaway flags are enabled.
    if (!configure(handle, 9, limits, limits.length)) {
      throw new Error(`SetInformationJobObject failed (${String(lastError())})`)
    }
  } catch (error) {
    closeHandle(handle)
    throw error
  }
  let closed = false
  return {
    name,
    close() {
      if (closed) return
      if (!closeHandle(handle)) throw new Error(`CloseHandle(job) failed (${String(lastError())})`)
      closed = true
    },
  }
}
