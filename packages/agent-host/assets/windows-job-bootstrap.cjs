// Runs before the dsh entrypoint via the first NODE_OPTIONS --require, with an
// argv --require fallback for runtimes that disable NODE_OPTIONS. The parent
// already configured the job; dsh runs only after successful assignment.
// Only the parent keeps a lasting handle, so parent death kills the whole tree.
// https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
'use strict'

const { isMainThread } = require('node:worker_threads')

if (process.platform === 'win32' && isMainThread) {
  const name = process.env.DSH_DESKTOP_JOB_NAME
  // Descendants inherit NODE_OPTIONS and Job membership, but not the one-shot
  // name. Custom fork environments need no extra marker to retain membership.
  if (name !== undefined) {
    delete process.env.DSH_DESKTOP_JOB_NAME
    if (!/^Local\\dsh-desktop-[0-9a-f-]{36}$/u.test(name)) throw new Error('invalid desktop job name')
    const { createRequire } = require('node:module')
    const native = createRequire(process.argv[1])('koffi')
    const kernel = native.load('kernel32.dll')
    const open = kernel.func('__stdcall', 'OpenJobObjectW', 'void *', ['uint32', 'int', 'str16'])
    const assign = kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', ['void *', 'void *'])
    const current = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', [])
    const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
    // JOB_OBJECT_ASSIGN_PROCESS, no inheritance. A dead parent => Open fails.
    const handle = open(0x0001, 0, name)
    if (handle === null) throw new Error(`OpenJobObjectW failed (${String(lastError())})`)
    let assignmentError
    try {
      if (!assign(handle, current())) throw new Error(`AssignProcessToJobObject failed (${String(lastError())})`)
    } catch (error) {
      assignmentError = error
    }
    const closed = close(handle)
    if (assignmentError !== undefined) throw assignmentError
    if (!closed) throw new Error(`CloseHandle(job bootstrap) failed (${String(lastError())})`)
  }
}
