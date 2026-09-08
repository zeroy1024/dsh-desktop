import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
it.each(['native', 'ptc'])('Loader composition: automatic image lookup and durable reuse (%s)', async mode => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(require.resolve('tsx/esm')).href,
    fileURLToPath(new URL('./fixtures/runner.mjs', import.meta.url)), mode,
  ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })
  expect(stdout).toContain('"ok":true')
}, 50_000)
