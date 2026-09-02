/**
 * runtime-archive.ts — 打包态首启解压 dsh-cli 运行时。
 *
 * 安装产物只携带单个未压缩 tar（resources/dsh-cli.tar，见
 * stage-runtime-archive.ts），首次启动解压到 userData/dsh-runtime/<version>/：
 *
 *   - 完成标记 .complete 记录 tar 的 size+mtimeMs，命中即短路（微秒级），
 *     restart-agent 路径幂等安全
 *   - 解压到同盘 .extract-<version>-<pid> 临时目录，rename 原子切换；
 *     任何失败清理临时目录，下次启动重新来过，不会留下半成品
 *   - 解压成功后异步清扫其他版本目录（旧版本、中断的临时目录）
 *
 * 纯 Node 模块（不 import electron），路径与平台由调用方注入，可单测。
 * 解压用系统 tar：macOS/Linux 自带 bsdtar/GNU tar，Windows 10+ 自带
 * bsdtar（System32\tar.exe）；tar 内无符号链接（建包时 -h 已解引用），
 * Windows 解压不需要任何特权。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface EnsureDshRuntimeOptions {
  /** Electron userData 目录。 */
  userDataDir: string
  /** app 版本号，作为解压目标目录名与戳。 */
  version: string
  /** 安装产物内的 dsh-cli.tar 绝对路径。 */
  archivePath: string
  /** 测试注入；默认 process.platform。 */
  platform?: NodeJS.Platform
  /** 测试注入；默认 process.env.SystemRoot（仅 win32 用来定位系统 tar.exe）。 */
  systemRoot?: string
}

const MARKER_FILENAME = '.complete'
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
/** 解压验收：CLI 入口必须存在。 */
const REQUIRED_ENTRY = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

interface Marker {
  size: number
  mtimeMs: number
}

function resolveTarCommand(platform: NodeJS.Platform, systemRoot: string | undefined): string {
  if (platform !== 'win32') return 'tar'
  // Windows 10 1803+ 自带 bsdtar；优先取系统路径，避免 PATH 里的同名程序
  const systemTar = systemRoot === undefined ? undefined : join(systemRoot, 'System32', 'tar.exe')
  return systemTar !== undefined && existsSync(systemTar) ? systemTar : 'tar'
}

function runTar(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      // 只保留尾部，错误信息够诊断即可
      stderr = (stderr + chunk.toString('utf8')).slice(-4096)
    })
    child.on('error', (error) => {
      rejectPromise(new Error(
        `dsh 运行时解压失败：无法执行系统 tar（${command}）：${error.message}。Windows 10+ 应自带 tar.exe`,
      ))
    })
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`dsh 运行时解压失败：tar 退出码 ${code}：${stderr.trim()}`))
    })
  })
}

async function readMarker(markerPath: string): Promise<Marker | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as Partial<Marker>
    if (typeof parsed.size === 'number' && typeof parsed.mtimeMs === 'number') {
      return { size: parsed.size, mtimeMs: parsed.mtimeMs }
    }
  } catch {
    // 缺文件或坏 JSON：当作无戳
  }
  return null
}

/** 清扫 dsh-runtime 下当前版本以外的目录（旧版本、中断的解压临时目录）。 */
export async function sweepOldRuntimes(rootDir: string, keepVersion: string): Promise<void> {
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== keepVersion)
    .map((entry) => rm(join(rootDir, entry.name), { recursive: true, force: true })
      .catch(() => {})))
}

/**
 * 确保 dsh-cli 运行时已解压，返回其根目录（内含 node_modules/）。
 *
 * @throws tar 缺失、解压失败或结果不完整时给出可读错误；不留下半成品目录。
 */
export async function ensureDshRuntime(options: EnsureDshRuntimeOptions): Promise<string> {
  const { userDataDir, version, archivePath } = options
  if (!SAFE_VERSION.test(version)) {
    throw new Error(`dsh 运行时解压失败：非法版本号 ${JSON.stringify(version)}`)
  }
  const rootDir = join(userDataDir, 'dsh-runtime')
  const versionDir = join(rootDir, version)
  const markerPath = join(versionDir, MARKER_FILENAME)

  const archiveStat = await stat(archivePath).catch(() => {
    throw new Error(`dsh 运行时解压失败：安装产物缺少运行时包 ${archivePath}`)
  })
  const marker = await readMarker(markerPath)
  if (marker !== null && marker.size === archiveStat.size && marker.mtimeMs === archiveStat.mtimeMs) {
    return versionDir
  }

  await rm(versionDir, { recursive: true, force: true })
  await mkdir(rootDir, { recursive: true })
  const tmpDir = join(rootDir, `.extract-${version}-${process.pid}`)
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })
  try {
    await runTar(resolveTarCommand(options.platform ?? process.platform, options.systemRoot), [
      '-xf', archivePath, '-C', tmpDir,
    ])
    await stat(join(tmpDir, REQUIRED_ENTRY)).catch(() => {
      throw new Error('dsh 运行时解压失败：解压结果缺少 dsh CLI 入口（bin.js），安装包可能损坏')
    })
    await rename(tmpDir, versionDir)
    const markerContent: Marker = { size: archiveStat.size, mtimeMs: archiveStat.mtimeMs }
    await writeFile(markerPath, `${JSON.stringify(markerContent)}\n`)
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  // 清扫不阻塞启动；失败（占用、权限）留到下次
  void sweepOldRuntimes(rootDir, version).catch(() => {})
  return versionDir
}
