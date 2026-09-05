import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
if (mode !== 'leaf') {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), mode === 'middle' ? 'leaf' : 'middle'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: process.env,
    windowsHide: true,
  })
  if (mode === 'middle') {
    child.on('message', () => { process.send?.({ pids: [process.pid, child.pid] }) })
  } else {
    child.on('message', ({ pids }) => {
      writeFileSync(process.env.DSH_TEST_JOB_PIDS, JSON.stringify([process.pid, ...pids]))
      console.log('dsh web: http://127.0.0.1:4567/?token=job-test-token')
      if (process.env.DSH_TEST_JOB_EXIT === '1') setTimeout(() => process.exit(2), 100)
    })
  }
} else {
  process.send?.({ ready: true })
}
setInterval(() => {}, 1_000)
