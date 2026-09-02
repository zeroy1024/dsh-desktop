/**
 * 构建 node 半（ESM lib/index.js）与 client 半（ModuleLoader 工厂 lib/client.js）。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildClientBundle } from '@dsh-desktop/plugin-kit'

const appDir = dirname(fileURLToPath(import.meta.url))
process.chdir(appDir)

await build({
  absWorkingDir: appDir,
  bundle: true,
  packages: 'external',
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
})

await buildClientBundle({
  id: '@dsh-desktop/archive-manager',
  entry: resolve(appDir, 'src/client/index.ts'),
  outfile: resolve(appDir, 'lib/client.js'),
})
