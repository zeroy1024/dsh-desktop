/**
 * 扫描 app 内置插件目录，供 desktop profile 物化做符号链接。
 * 开发态指向仓库 packages/plugins；打包态指向 extraResources/plugins（P4）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { BundledPlugin } from '@dsh-desktop/agent-host'

/** desktop 包 version，写入 profile 戳。 */
export function appVersion(): string {
  const pkgPath = join(import.meta.dirname, '..', 'package.json')
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
  return parsed.version ?? '0.0.0'
}

/** 内置插件根目录。 */
export function bundledPluginsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'plugins')
    : join(import.meta.dirname, '..', '..', '..', 'packages', 'plugins')
}

/** 每个含 package.json 的子目录即一个内置插件。 */
export function resolveBundledPlugins(): BundledPlugin[] {
  const root = bundledPluginsRoot()
  if (!existsSync(root)) return []
  const plugins: BundledPlugin[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    plugins.push({ name: manifest.name, dir })
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  return plugins
}
