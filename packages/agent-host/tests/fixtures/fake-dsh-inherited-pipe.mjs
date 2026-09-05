import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// The descendant installs its TERM trap before signaling readiness. It retains
// the supervisor's stderr even after this CLI exits, reproducing subagent stdio.
const descendant = spawn(process.execPath, ['-e', `
  process.on('SIGTERM', () => {})
  process.send('ready')
  setInterval(() => {}, 1000)
`], {
  detached: process.env.FAKE_DSH_DETACHED === '1',
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
})
descendant.once('message', () => {
  if (process.env.FAKE_DSH_DESCENDANT_PID) writeFileSync(process.env.FAKE_DSH_DESCENDANT_PID, String(descendant.pid))
  console.log('dsh web: http://127.0.0.1:4567/?token=fixture')
  setTimeout(() => process.exit(2), 50)
})
