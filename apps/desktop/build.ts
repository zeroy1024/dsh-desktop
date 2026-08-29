/**
 * build.ts — 打包 Electron 主进程与 preload。
 *
 * 主进程输出 ESM（dist/main.mjs，Electron >= 28 支持 ESM 入口）；
 * preload 输出 CJS（dist/preload.cjs，sandbox 模式下 preload 必须是 CJS）。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context, type BuildOptions } from 'esbuild'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)))
const watch = process.argv.includes('--watch')

const common: BuildOptions = {
  absWorkingDir: appDir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

const mains: BuildOptions[] = [
  { ...common, entryPoints: ['src/main/index.ts'], format: 'esm', outfile: 'dist/main.mjs' },
  { ...common, entryPoints: ['src/preload/index.ts'], format: 'cjs', outfile: 'dist/preload.cjs' },
]

if (watch) {
  const contexts = await Promise.all(mains.map((opts) => context(opts)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  console.log('esbuild watch 已启动')
} else {
  await Promise.all(mains.map((opts) => build(opts)))
}
