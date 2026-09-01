/** 构建 Host 半（ESM）与浏览器半（ModuleLoader 工厂）。 */
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
  id: '@dsh-desktop/web-search',
  entry: resolve(appDir, 'src/client/index.ts'),
  outfile: resolve(appDir, 'lib/client.js'),
})
