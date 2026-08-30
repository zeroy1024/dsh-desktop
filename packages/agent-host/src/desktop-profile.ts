/**
 * desktop-profile.ts — 物化 `$DSH_HOME/profiles/desktop/`。
 *
 * 这是 app 托管的内置 profile（ADR-0004），不是用户用 `dsh plugin add` 装的。
 * 目录里只有 manifest、用户层空 patch、以及指向 app 内置插件包的符号链接。
 * `@deepseek-ai/dsh-base` / `dsh-web-app` 仍从 dsh 安装闭包解析，不在此复制。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const DESKTOP_PROFILE_NAME = 'desktop'
export const STAMP_FILENAME = '.dsh-desktop.json'
export const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

export interface BundledPlugin {
  /** package.json name，也是 node_modules 下的链接名。 */
  name: string
  /** 插件包根目录（含 package.json / lib / cordis.patch.yml）。 */
  dir: string
}

export interface MaterializeDesktopProfileOptions {
  dshHome: string
  plugins: readonly BundledPlugin[]
  /** 写入戳的 app 版本，用于自愈判断。 */
  version: string
}

interface Stamp {
  app: 'deepseek-harness-desktop'
  version: string
  plugins: string[]
}

function stampPath(profileDir: string): string {
  return join(profileDir, STAMP_FILENAME)
}

function readStamp(profileDir: string): Stamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(profileDir), 'utf8')) as Partial<Stamp>
    if (parsed.app === 'deepseek-harness-desktop' && typeof parsed.version === 'string') {
      return {
        app: parsed.app,
        version: parsed.version,
        plugins: Array.isArray(parsed.plugins)
          ? parsed.plugins.filter((name): name is string => typeof name === 'string')
          : [],
      }
    }
  } catch {
    // 缺文件或坏 JSON：当作无戳
  }
  return null
}

const PACKAGE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/u

function validatePackageName(name: string): void {
  const valid = name.startsWith('@')
    ? (() => {
        const [scope, packageName, extra] = name.slice(1).split('/')
        return extra === undefined
          && scope !== undefined
          && packageName !== undefined
          && PACKAGE_SEGMENT.test(scope)
          && PACKAGE_SEGMENT.test(packageName)
      })()
    : PACKAGE_SEGMENT.test(name)
  if (!valid) throw new Error(`desktop profile: 非法插件包名 ${JSON.stringify(name)}`)
}

function pluginLinkPath(profileDir: string, name: string): string {
  validatePackageName(name)
  const modulesDir = resolve(profileDir, 'node_modules')
  const link = resolve(modulesDir, ...name.split('/'))
  if (!link.startsWith(`${modulesDir}${sep}`)) {
    throw new Error(`desktop profile: 插件链接越过 node_modules：${name}`)
  }
  return link
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function ensureRealDirectory(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`desktop profile: 托管目录不安全（不是实体目录）：${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(path)
  }
}

function ensurePluginParent(profileDir: string, name: string): void {
  const modulesDir = join(profileDir, 'node_modules')
  ensureRealDirectory(modulesDir)
  if (name.startsWith('@')) ensureRealDirectory(join(modulesDir, name.split('/')[0]!))
}

function validatePlugins(plugins: readonly BundledPlugin[]): BundledPlugin[] {
  const names = new Set<string>()
  return plugins.map((plugin) => {
    validatePackageName(plugin.name)
    if ((BASE_BUNDLES as readonly string[]).includes(plugin.name) || names.has(plugin.name)) {
      throw new Error(`desktop profile: 插件包名重复或与基础 bundle 冲突：${plugin.name}`)
    }
    names.add(plugin.name)
    const dir = resolve(plugin.dir)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath) || !statSync(dir).isDirectory()) {
      throw new Error(`desktop profile: 插件目录无效 ${plugin.dir}`)
    }
    let manifest: { name?: unknown }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown }
    } catch {
      throw new Error(`desktop profile: 插件 manifest 无效 ${manifestPath}`)
    }
    if (manifest.name !== plugin.name) {
      throw new Error(
        `desktop profile: 插件名不匹配，声明 ${plugin.name}，manifest 为 ${String(manifest.name)}`,
      )
    }
    return { name: plugin.name, dir }
  })
}

function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`desktop profile: ${link} 已存在且不是符号链接，请手动移除`)
    }
    if (resolve(dirname(link), readlinkSync(link)) === resolve(target)) return
    unlinkSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
}

/**
 * 物化或自愈 desktop profile。
 *
 * @returns profile 目录绝对路径。
 * @throws 目录已被非本 app 占用（无戳）时拒绝覆盖。
 */
export function materializeDesktopProfile(options: MaterializeDesktopProfileOptions): string {
  // 所有不可信路径/manifest 在碰 profile 前一次性校验，失败时不留下半成品。
  const plugins = validatePlugins(options.plugins)
  const profileDir = join(options.dshHome, 'profiles', DESKTOP_PROFILE_NAME)
  const manifestPath = join(profileDir, 'package.json')
  if (existsSync(profileDir)) {
    const profileStat = lstatSync(profileDir)
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
      throw new Error(`desktop profile: 托管目录不安全（不是实体目录）：${profileDir}`)
    }
  }
  const previousStamp = readStamp(profileDir)
  let nonEmptyUnowned = false
  if (existsSync(profileDir) && previousStamp === null) {
    nonEmptyUnowned = readdirSync(profileDir).length > 0
  }
  const foreign = nonEmptyUnowned || (existsSync(manifestPath) && previousStamp === null)
  if (foreign) {
    throw new Error(
      `desktop profile: ${profileDir} 已存在但不是本 app 托管的（缺少 ${STAMP_FILENAME}）。`
        + '请改名移走该目录，或设置 DSH_HOME 使用另一份 home。',
    )
  }

  mkdirSync(profileDir, { recursive: true })
  // 新目录先落所有权戳。后续任一步失败，下次启动会把它当本 app 半成品自愈，
  // 不会因为 manifest 已存在却无戳而误判成用户 profile。
  if (previousStamp === null) {
    const ownershipStamp: Stamp = {
      app: 'deepseek-harness-desktop',
      version: options.version,
      plugins: [],
    }
    atomicWrite(stampPath(profileDir), `${JSON.stringify(ownershipStamp, undefined, 2)}\n`)
  }

  const bundles = [...BASE_BUNDLES, ...plugins.map((plugin) => plugin.name)]
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }
  atomicWrite(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    atomicWrite(
      patchPath,
      `# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n`,
    )
  }

  for (const plugin of plugins) {
    ensurePluginParent(profileDir, plugin.name)
    ensureSymlink(pluginLinkPath(profileDir, plugin.name), plugin.dir)
  }

  const currentNames = new Set(plugins.map((plugin) => plugin.name))
  for (const staleName of previousStamp?.plugins ?? []) {
    if (currentNames.has(staleName)) continue
    let staleLink: string
    try {
      staleLink = pluginLinkPath(profileDir, staleName)
      ensurePluginParent(profileDir, staleName)
    } catch {
      continue
    }
    try {
      if (lstatSync(staleLink).isSymbolicLink()) unlinkSync(staleLink)
    } catch {
      // 已被移除或改成用户内容：不碰非符号链接。
    }
  }

  const stamp: Stamp = {
    app: 'deepseek-harness-desktop',
    version: options.version,
    plugins: [...currentNames],
  }
  atomicWrite(stampPath(profileDir), `${JSON.stringify(stamp, undefined, 2)}\n`)
  return profileDir
}
