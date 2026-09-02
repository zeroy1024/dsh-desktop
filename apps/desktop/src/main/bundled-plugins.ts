/**
 * 扫描 staging 后的 app 内置插件目录，供 desktop profile 物化做符号链接。
 * 插件位于 dsh CLI 的 node_modules 闭包内（打包态为首启解压出的副本，见
 * paths.ts dshRuntimeRoot），确保 Host bare import 与 dsh
 * 运行时共享同一份 Cordis/service-definition 包。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { BundledPlugin } from '@dsh-desktop/agent-host'
import { dshRuntimeRoot } from './paths'

/** desktop 包 version，写入 profile 戳。 */
export function appVersion(): string {
  const pkgPath = join(import.meta.dirname, '..', 'package.json')
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  return parsed.version ?? '0.0.0'
}

/** 内置插件根目录。 */
export function bundledPluginsRoot(): string {
  return app.isPackaged
    ? join(dshRuntimeRoot(), 'node_modules', '@dsh-desktop')
    : join(import.meta.dirname, '..', '..', '..', 'vendor', 'dsh-cli', 'node_modules', '@dsh-desktop')
}

/** 每个含 package.json 的子目录即一个内置插件；`dshDesktop.enabled: false` 表示保留在仓库但默认不装配。 */
export function resolveBundledPlugins(): BundledPlugin[] {
  const root = bundledPluginsRoot()
  if (!existsSync(root)) return []
  const plugins: BundledPlugin[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string
      dshDesktop?: { enabled?: boolean }
    }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    if (manifest.dshDesktop?.enabled === false) continue
    plugins.push({ name: manifest.name, dir })
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return plugins
}
