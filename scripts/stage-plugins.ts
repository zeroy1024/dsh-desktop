/**
 * 把 workspace 内置插件的发布面 staging 到 dsh CLI 安装闭包中。
 *
 * desktop profile 最终链接这些副本，而不是 workspace 源目录。Host 插件的
 * bare @deepseek-ai/* import 因而从 vendor/dsh-cli/node_modules 解析，与 dsh
 * 自身共享同一份 Cordis、HarnessError 和 service-definition identity。
 *
 * 声明 dshDesktop.enabled:false 的插件（默认不装配，如 hello-panel）不进
 * staged 闭包：不随安装包分发。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface PluginManifest {
  name?: unknown
  files?: unknown
  dshDesktop?: { enabled?: unknown }
}

export interface StagePluginsOptions {
  /** 插件源目录（缺省 packages/plugins）。 */
  pluginsDir?: string
  /** dsh CLI 闭包 node_modules（缺省 vendor/dsh-cli/node_modules）。 */
  cliModulesDir?: string
  /** 根 package.json（app 版本来源，缺省仓库根）。 */
  appManifestPath?: string
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/u

function pluginName(name: unknown, manifestPath: string): string {
  if (typeof name !== 'string' || !name.startsWith('@dsh-desktop/')) {
    throw new Error(`stage plugins: ${manifestPath} 必须声明 @dsh-desktop/* 包名`)
  }
  const segment = name.slice('@dsh-desktop/'.length)
  if (!SAFE_SEGMENT.test(segment)) throw new Error(`stage plugins: 非法包名 ${name}`)
  return segment
}

function publishFiles(files: unknown, manifestPath: string): string[] {
  if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== 'string')) {
    throw new Error(`stage plugins: ${manifestPath} 必须声明非空 files[]`)
  }
  return files as string[]
}

function safeSource(packageDir: string, relativePath: string): string {
  const source = resolve(packageDir, relativePath)
  if (source !== packageDir && !source.startsWith(`${packageDir}${sep}`)) {
    throw new Error(`stage plugins: files 条目越界 ${relativePath}`)
  }
  return source
}

/** 当前 app 版本：staged 发布面 manifest 以此为准（ADR-0004：插件版本 = app 版本）。 */
function readAppVersion(appManifestPath: string): string {
  const manifest = JSON.parse(readFileSync(appManifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`stage plugins: ${appManifestPath} 缺少非空 version`)
  }
  return manifest.version
}

export function stagePlugins(options: StagePluginsOptions = {}): string {
  const pluginsDir = resolve(options.pluginsDir ?? join(rootDir, 'packages', 'plugins'))
  const cliModulesDir = resolve(options.cliModulesDir ?? join(rootDir, 'vendor', 'dsh-cli', 'node_modules'))
  const targetScopeDir = join(cliModulesDir, '@dsh-desktop')
  const appVersion = readAppVersion(resolve(options.appManifestPath ?? join(rootDir, 'package.json')))
  if (!existsSync(join(cliModulesDir, '@deepseek-ai', 'dsh', 'package.json'))) {
    throw new Error('stage plugins: 缺少 vendor/dsh-cli，请先运行 pnpm sync:upstream')
  }

  // 与目标同一目录，保证最终 rename 不会跨文件系统失去原子性。
  const scratch = mkdtempSync(join(cliModulesDir, '.dsh-desktop-plugins-'))
  const stagedScope = join(scratch, '@dsh-desktop')
  mkdirSync(stagedScope, { recursive: true })
  try {
    const entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .toSorted((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const packageDir = join(pluginsDir, entry.name)
      const manifestPath = join(packageDir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
      // 默认不装配的插件（dshDesktop.enabled:false，如 hello-panel/panel-page-stub）
      // 不进 staged 闭包：不随安装包分发；bundled-plugins 侧的 enabled 判定保持兜底。
      if (manifest.dshDesktop?.enabled === false) continue
      const segment = pluginName(manifest.name, manifestPath)
      const destination = join(stagedScope, segment)
      mkdirSync(destination, { recursive: true })
      // staged 发布面版本改写为 app 版本（ADR-0004 机制化）；源 package.json 不动，
      // 保持开发态 0.0.1，避免改一个插件就制造一次全仓 version 抖动
      writeFileSync(
        join(destination, 'package.json'),
        `${JSON.stringify({ ...manifest, version: appVersion }, null, 2)}\n`,
      )
      for (const relativePath of publishFiles(manifest.files, manifestPath)) {
        const source = safeSource(packageDir, relativePath)
        if (!existsSync(source)) {
          throw new Error(`stage plugins: ${String(manifest.name)} 尚未构建 ${relativePath}`)
        }
        const output = join(destination, relativePath)
        mkdirSync(dirname(output), { recursive: true })
        cpSync(source, output, { recursive: true })
      }
    }

    mkdirSync(dirname(targetScopeDir), { recursive: true })
    const previous = `${targetScopeDir}.previous`
    rmSync(previous, { recursive: true, force: true })
    if (existsSync(targetScopeDir)) renameSync(targetScopeDir, previous)
    try {
      renameSync(stagedScope, targetScopeDir)
      rmSync(previous, { recursive: true, force: true })
    } catch (error) {
      rmSync(targetScopeDir, { recursive: true, force: true })
      if (existsSync(previous)) renameSync(previous, targetScopeDir)
      throw error
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const stamp = join(targetScopeDir, '.stage.json')
  writeFileSync(stamp, `${JSON.stringify({ stagedAt: new Date().toISOString(), source: basename(pluginsDir) })}\n`)
  return targetScopeDir
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`[plugins] staged: ${stagePlugins()}`)
}
