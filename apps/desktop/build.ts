/**
 * build.ts — 打包 Electron 主进程、preload 与启动层资源。
 *
 * 主进程输出 ESM（dist/main.mjs，Electron >= 28 支持 ESM 入口）；
 * preload 输出 CJS（dist/*.cjs，sandbox 模式下 preload 必须是 CJS）；
 * 启动层渲染脚本输出 IIFE（dist/splash.js，file:// 下 ESM 会被 CORS 拦截）；
 * 启动层 HTML/CSS 不经 bundler，直接拷入 dist。
 */
import { copyFile } from 'node:fs/promises'
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
  { ...common, entryPoints: ['src/preload/splash.ts'], format: 'cjs', outfile: 'dist/splash-preload.cjs' },
  // 启动层渲染脚本：无依赖、跑在浏览器上下文
  {
    ...common,
    platform: 'browser',
    external: [],
    entryPoints: ['src/renderer/splash/splash.ts'],
    format: 'iife',
    outfile: 'dist/splash.js',
  },
]

/** 启动层静态页与样式：构建产物即运行时文件，原样拷贝。 */
const splashAssets: Array<[string, string]> = [
  ['src/renderer/splash/index.html', 'dist/splash.html'],
  ['src/renderer/splash/splash.css', 'dist/splash.css'],
]

function copySplashAssets(): Promise<void[]> {
  return Promise.all(splashAssets.map(([src, dest]) => copyFile(src, dest)))
}

if (watch) {
  const contexts = await Promise.all(mains.map((opts) => context(opts)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  await copySplashAssets()
  console.log('esbuild watch 已启动')
} else {
  await Promise.all(mains.map((opts) => build(opts)))
  await copySplashAssets()
}
