import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { windowsJobNodeOptions } from '../src/windows-job'

it.each([true, false])('executes our preload once before user flags, with NODE_OPTIONS enabled=%s', (enabled) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh job options '))
  try {
    const first = join(root, 'first bootstrap.cjs')
    const user = join(root, 'user preload.cjs')
    const entry = join(root, 'entry.cjs')
    writeFileSync(first, "globalThis.order = ['job']\n")
    writeFileSync(user, "globalThis.order.push('user')\n")
    writeFileSync(entry, 'console.log(JSON.stringify({ order: globalThis.order, stack: Error.stackTraceLimit }))\n')
    const inherited = `--require "${user.replaceAll('\\', '/')}" --stack-trace-limit=37`
    const result = spawnSync(process.execPath, ['--require', first, entry], {
      env: { ...process.env, NODE_OPTIONS: enabled ? windowsJobNodeOptions(first, inherited) : undefined },
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(enabled
      ? { order: ['job', 'user'], stack: 37 }
      : { order: ['job'], stack: 10 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
