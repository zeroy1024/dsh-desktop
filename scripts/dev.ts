/**
 * dev.ts — 一键开发：校验上游构建产物与 Electron 二进制 → 构建 desktop → 启动 Electron。
 *
 * 用法：pnpm dev
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = join(rootDir, 'apps', 'desktop')

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// 1. 上游 CLI 安装产物（vendor/dsh-cli，由 pnpm sync:upstream 生成）
const cliEntry = join(rootDir, 'vendor', 'dsh-cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(cliEntry)) {
  console.error('未找到 dsh CLI 安装产物（vendor/dsh-cli/…/lib/bin.js）。')
  console.error('请先执行：pnpm sync:upstream')
  process.exit(1)
}

// 2. Electron 二进制（electron@44+ 不再自动下载，需显式 install-electron）
const requireFromDesktop = createRequire(join(desktopDir, 'package.json'))
const electronPkg = requireFromDesktop.resolve('electron/package.json')
if (!existsSync(join(dirname(electronPkg), 'dist'))) {
  console.log('Electron 二进制缺失，运行 install-electron 下载…')
  run('pnpm', ['--filter', '@dsh-desktop/desktop', 'exec', 'install-electron'], rootDir)
}

// 3. 构建并启动
run('pnpm', ['--filter', '@dsh-desktop/desktop', 'build'], rootDir)
run('pnpm', ['--filter', '@dsh-desktop/desktop', 'start'], rootDir)
