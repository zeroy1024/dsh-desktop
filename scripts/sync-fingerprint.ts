/**
 * 上游输入指纹：upstream HEAD + patches.yml + 登记补丁内容，拼成 `<commit> <sha256>`。
 *
 * sync-upstream.ts 只在全量同步成功后写入 vendor/.upstream-commit（markFullySynced）；
 * dev.ts 用同一指纹核对 vendor/dsh-cli 是否仍与当前补丁队列一致——--skip-build /
 * --skip-pack 留下的旧产物在这里现形。目录参数可注入，供测试用临时 git 仓库演练。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { spawnCommandSync } from './command'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const defaultUpstreamDir = join(rootDir, 'upstream')
export const defaultPatchesDir = join(rootDir, 'patches')

export interface PatchEntry {
  file: string
  reason: string
  upstream?: string
}

export interface SyncFingerprintOptions {
  /** upstream 子模块目录（缺省仓库 upstream/）。 */
  upstreamDir?: string
  /** patches/ 目录（缺省仓库 patches/）。 */
  patchesDir?: string
}

function capture(upstreamDir: string, args: string[]): string {
  const r = spawnCommandSync('git', args, { cwd: upstreamDir, stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`命令失败（exit ${String(r.status)}）：git ${args.join(' ')}`)
  return r.stdout.trim()
}

/** 校验补丁登记路径（必须位于 patches/ 内且以 .patch 结尾），返回绝对路径。 */
export function registeredPatchPath(file: string, patchesDir: string = defaultPatchesDir): string {
  const path = resolve(patchesDir, file)
  if (!path.startsWith(`${patchesDir}${sep}`) || !file.endsWith('.patch')) {
    throw new Error(`[patches] 非法补丁路径：${file}`)
  }
  return path
}

export function readPatchRegistry(patchesDir: string = defaultPatchesDir): PatchEntry[] {
  const registryPath = join(patchesDir, 'patches.yml')
  const registry = yaml.load(readFileSync(registryPath, 'utf8')) as { patches?: unknown } | null
  if (registry?.patches === undefined) return []
  if (!Array.isArray(registry.patches)) throw new Error('[patches] patches.yml 的 patches 必须是数组')
  const seen = new Set<string>()
  return registry.patches.map((value, index) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`[patches] 第 ${index + 1} 项必须是对象`)
    }
    const entry = value as Partial<PatchEntry>
    if (typeof entry.file !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`[patches] 第 ${index + 1} 项必须提供 file 与非空 reason`)
    }
    if (seen.has(entry.file)) throw new Error(`[patches] 重复登记：${entry.file}`)
    seen.add(entry.file)
    registeredPatchPath(entry.file, patchesDir)
    return {
      file: entry.file,
      reason: entry.reason,
      ...(typeof entry.upstream === 'string' ? { upstream: entry.upstream } : {}),
    }
  })
}

export function syncFingerprint(
  patches: readonly PatchEntry[],
  options: SyncFingerprintOptions = {},
): string {
  const upstreamDir = resolve(options.upstreamDir ?? defaultUpstreamDir)
  const patchesDir = resolve(options.patchesDir ?? defaultPatchesDir)
  const hash = createHash('sha256')
  hash.update(capture(upstreamDir, ['rev-parse', 'HEAD']))
  hash.update('\0')
  hash.update(readFileSync(join(patchesDir, 'patches.yml')))
  for (const entry of patches) {
    const patchPath = registeredPatchPath(entry.file, patchesDir)
    if (!existsSync(patchPath)) throw new Error(`[patches] 登记的文件不存在：${entry.file}`)
    hash.update('\0')
    hash.update(entry.file)
    hash.update('\0')
    hash.update(readFileSync(patchPath))
  }
  return `${capture(upstreamDir, ['rev-parse', 'HEAD'])} ${hash.digest('hex')}`
}