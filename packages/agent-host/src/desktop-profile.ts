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
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

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
}

function stampPath(profileDir: string): string {
  return join(profileDir, STAMP_FILENAME)
}

function readStamp(profileDir: string): Stamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(profileDir), 'utf8')) as Partial<Stamp>
    if (parsed.app === 'deepseek-harness-desktop' && typeof parsed.version === 'string') {
      return { app: parsed.app, version: parsed.version }
    }
  } catch {
    // 缺文件或坏 JSON：当作无戳
  }
  return null
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
    if (readlinkSync(link) === target) return
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
  const profileDir = join(options.dshHome, 'profiles', DESKTOP_PROFILE_NAME)
  const manifestPath = join(profileDir, 'package.json')
  const foreign = existsSync(manifestPath) && readStamp(profileDir) === null
  if (foreign) {
    throw new Error(
      `desktop profile: ${profileDir} 已存在但不是本 app 托管的（缺少 ${STAMP_FILENAME}）。`
        + '请改名移走该目录，或设置 DSH_HOME 使用另一份 home。',
    )
  }

  mkdirSync(profileDir, { recursive: true })

  const bundles = [...BASE_BUNDLES, ...options.plugins.map((plugin) => plugin.name)]
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    writeFileSync(
      patchPath,
      `# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n`,
    )
  }

  for (const plugin of options.plugins) {
    if (!existsSync(join(plugin.dir, 'package.json'))) {
      throw new Error(`desktop profile: 插件目录无效 ${plugin.dir}`)
    }
    ensureSymlink(join(profileDir, 'node_modules', plugin.name), plugin.dir)
  }

  const stamp: Stamp = { app: 'deepseek-harness-desktop', version: options.version }
  writeFileSync(stampPath(profileDir), `${JSON.stringify(stamp, undefined, 2)}\n`)
  return profileDir
}
