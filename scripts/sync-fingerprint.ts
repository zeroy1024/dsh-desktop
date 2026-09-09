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
  /** Optional for legacy queues used by --replace-patches-from. */
  category?: 'extension' | 'compatibility' | 'behavior' | 'product-extension'
  feature?: string
  consumers?: string[]
  upstreamStatus?: 'unverified' | 'pending' | 'submitted' | 'accepted' | 'local-only'
  removeWhen?: string
  dependencies?: { file: string; kind: 'semantic' | 'context'; reason: string }[]
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
  const entries = registry.patches.map((value, index): PatchEntry => {
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
    for (const key of ['upstream', 'feature', 'removeWhen'] as const) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].trim() === '')) {
        throw new Error(`[patches] ${entry.file} 的 ${key} 必须是非空字符串`)
      }
    }
    if (entry.category !== undefined
      && !['extension', 'compatibility', 'behavior', 'product-extension'].includes(entry.category)) {
      throw new Error(`[patches] ${entry.file} 的 category 非法`)
    }
    if (entry.upstreamStatus !== undefined
      && !['unverified', 'pending', 'submitted', 'accepted', 'local-only'].includes(entry.upstreamStatus)) {
      throw new Error(`[patches] ${entry.file} 的 upstreamStatus 非法`)
    }
    if ((entry.upstreamStatus === 'submitted' || entry.upstreamStatus === 'accepted') && !entry.upstream) {
      throw new Error(`[patches] ${entry.file} 的上游提交状态需要 upstream 引用`)
    }
    if (entry.consumers !== undefined && (!Array.isArray(entry.consumers) || entry.consumers.length === 0
      || entry.consumers.some(consumer => typeof consumer !== 'string' || consumer.trim() === '')
      || new Set(entry.consumers).size !== entry.consumers.length)) {
      throw new Error(`[patches] ${entry.file} 的 consumers 必须是非空且不重复的字符串数组`)
    }
    if (entry.dependencies !== undefined) {
      if (!Array.isArray(entry.dependencies)) throw new Error(`[patches] ${entry.file} 的 dependencies 必须是数组`)
      const dependencies = new Set<string>()
      for (const dependency of entry.dependencies) {
        if (typeof dependency !== 'object' || dependency === null
          || typeof dependency.file !== 'string'
          || !['semantic', 'context'].includes(dependency.kind)
          || typeof dependency.reason !== 'string' || dependency.reason.trim() === '') {
          throw new Error(`[patches] ${entry.file} 的依赖必须提供 file、kind 和非空 reason`)
        }
        registeredPatchPath(dependency.file, patchesDir)
        if (dependencies.has(dependency.file)) throw new Error(`[patches] ${entry.file} 重复依赖 ${dependency.file}`)
        dependencies.add(dependency.file)
      }
    }
    return {
      file: entry.file,
      reason: entry.reason,
      ...(typeof entry.upstream === 'string' ? { upstream: entry.upstream } : {}),
      ...(entry.category === undefined ? {} : { category: entry.category }),
      ...(entry.feature === undefined ? {} : { feature: entry.feature }),
      ...(entry.consumers === undefined ? {} : { consumers: entry.consumers }),
      ...(entry.upstreamStatus === undefined ? {} : { upstreamStatus: entry.upstreamStatus }),
      ...(entry.removeWhen === undefined ? {} : { removeWhen: entry.removeWhen }),
      ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
    }
  })
  const preceding = new Set<string>()
  for (const entry of entries) {
    for (const dependency of entry.dependencies ?? []) {
      if (!seen.has(dependency.file)) throw new Error(`[patches] ${entry.file} 依赖未登记补丁 ${dependency.file}`)
      // This also rejects self-dependencies and cycles: every edge must point backward.
      if (!preceding.has(dependency.file)) {
        throw new Error(`[patches] ${entry.file} 的 ${dependency.kind} 依赖 ${dependency.file} 必须先于它登记`)
      }
    }
    preceding.add(entry.file)
  }
  return entries
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
