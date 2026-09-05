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
  external: ['@deepseek-ai/*', 'zod'],
  entryPoints: ['src/index.ts', 'src/session-query.ts'],
  outdir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
})

await buildClientBundle({
  id: '@dsh-desktop/rewind',
  entry: resolve(appDir, 'src/client/index.ts'),
  outfile: resolve(appDir, 'lib/client.js'),
})
