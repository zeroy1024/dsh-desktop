import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createWindowsJob, windowsJobNodeOptions } from '../../src/windows-job.ts'

const cli = fileURLToPath(new URL('./windows-job-tree.mjs', import.meta.url))
const bootstrap = fileURLToPath(new URL('../../assets/windows-job-bootstrap.cjs', import.meta.url))
const job = createWindowsJob(cli)
const child = spawn(process.execPath, ['--require', bootstrap, cli], {
  stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  env: { ...process.env, DSH_DESKTOP_JOB_NAME: job.name, NODE_OPTIONS: windowsJobNodeOptions(bootstrap, process.env.NODE_OPTIONS) },
})
child.stdout.pipe(process.stdout)
child.on('exit', () => job.close())
setInterval(() => {}, 1_000)
