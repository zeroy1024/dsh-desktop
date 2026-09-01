import { chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Preserve Chromium's setuid sandbox in Linux AppImage and tar.gz targets. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return
  const sandbox = join(context.appOutDir, 'chrome-sandbox')
  await chmod(sandbox, 0o4755)
  const mode = (await stat(sandbox)).mode & 0o7777
  if (mode !== 0o4755) {
    throw new Error(`chrome-sandbox mode is ${mode.toString(8)}, expected 4755`)
  }
}
