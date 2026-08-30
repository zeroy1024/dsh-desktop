/**
 * dev.ts — 一键开发：校验上游构建产物与 Electron 二进制 → 构建 desktop → 启动 Electron。
 *
 * 用法：pnpm dev
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// 2.5 dev 态品牌 app（仅 macOS）：克隆 Electron.app 为 "DeepSeek Harness.app"。
// Dock tooltip 取 app bundle 的文件名与 LaunchServices 记录，只改原 bundle 的
// plist 不够——目录名必须是产品名；APFS clonefile 克隆零额外磁盘。
// 幂等：electron 版本不变且产物在则跳过。打包态由 electron-builder 负责，与本步无关。
const brandParent = join(rootDir, 'vendor', 'dev-electron-app')
const brandApp = join(brandParent, 'DeepSeek Harness.app')
let devElectronBin: string | null = null
if (process.platform === 'darwin') {
  const srcApp = join(dirname(electronPkg), 'dist', 'Electron.app')
  const stampPath = join(brandParent, '.electron-version')
  const electronVersion = JSON.parse(readFileSync(electronPkg, 'utf8')).version as string
  const stampOk =
    existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === electronVersion
  if (!stampOk || !existsSync(brandApp)) {
    rmSync(brandParent, { recursive: true, force: true })
    mkdirSync(brandParent, { recursive: true })
    run('cp', ['-Rc', srcApp, brandApp], rootDir)
    const infoPlist = join(brandApp, 'Contents', 'Info.plist')
    const brand: Record<string, string> = {
      CFBundleName: 'DeepSeek Harness',
      CFBundleDisplayName: 'DeepSeek Harness',
      CFBundleIdentifier: 'ai.deepseek.harness.desktop',
    }
    for (const [key, value] of Object.entries(brand)) {
      const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, infoPlist])
      if (set.status !== 0) {
        spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, infoPlist])
      }
    }
    spawnSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', brandApp],
    )
    writeFileSync(stampPath, electronVersion)
  }
  devElectronBin = join(brandApp, 'Contents', 'MacOS', 'Electron')
}

// 3. 构建内置插件 + desktop 壳，再启动
run('pnpm', ['--filter', './packages/plugins/*', 'build'], rootDir)
run('pnpm', ['--filter', '@dsh-desktop/desktop', 'build'], rootDir)
if (devElectronBin !== null && existsSync(devElectronBin)) {
  run(devElectronBin, [desktopDir], rootDir)
} else {
  run('pnpm', ['--filter', '@dsh-desktop/desktop', 'start'], rootDir)
}
