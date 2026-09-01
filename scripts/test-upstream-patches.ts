/**
 * Run every upstream Vitest spec touched by the registered patch queue.
 *
 * `sync:upstream` proves the patches apply and the patched packages compile.
 * This companion gate proves the behavioral tests carried by those patches
 * actually execute. The inventory is derived from patch headers so adding a
 * patched spec automatically extends the CI gate.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { spawnPnpmSync } from './command'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamDir = resolve(rootDir, 'upstream')
const patchesDir = resolve(rootDir, 'patches')

interface PatchEntry {
  file?: unknown
}

interface PatchRegistry {
  patches?: unknown
}

/** Test paths encoded in `diff --git a/... b/...` patch headers. */
export function patchedTestPaths(patchSource: string): string[] {
  const paths = new Set<string>()
  const header = /^diff --git a\/(.+) b\/(.+)$/gmu
  const matches = [...patchSource.matchAll(header)]
  for (const [index, match] of matches.entries()) {
    const after = match[2]
    if (after === undefined || match.index === undefined) continue
    const next = matches[index + 1]?.index ?? patchSource.length
    const block = patchSource.slice(match.index, next)
    if (/^\+\+\+ \/dev\/null$/mu.test(block)) continue
    if (!/(?:^|\/)tests\/.*\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/u.test(after)) continue
    paths.add(after)
  }
  return [...paths].toSorted()
}

function registeredPatchFiles(): string[] {
  const registryPath = resolve(patchesDir, 'patches.yml')
  const registry = yaml.load(readFileSync(registryPath, 'utf8')) as PatchRegistry | null
  if (!Array.isArray(registry?.patches)) {
    throw new Error('upstream patch tests: patches/patches.yml 缺少 patches 数组')
  }
  return registry.patches.map((value, index) => {
    const entry = value as PatchEntry
    if (typeof entry?.file !== 'string' || !entry.file.endsWith('.patch')) {
      throw new Error(`upstream patch tests: patches 第 ${index + 1} 项缺少合法 file`)
    }
    const path = resolve(patchesDir, entry.file)
    if (!path.startsWith(`${patchesDir}${sep}`) || !existsSync(path)) {
      throw new Error(`upstream patch tests: patch 不存在或越界：${entry.file}`)
    }
    return path
  })
}

function main(): void {
  if (!existsSync(resolve(upstreamDir, 'package.json'))) {
    throw new Error('upstream patch tests: upstream submodule 未初始化')
  }

  const tests = new Set<string>()
  for (const patchPath of registeredPatchFiles()) {
    for (const path of patchedTestPaths(readFileSync(patchPath, 'utf8'))) tests.add(path)
  }
  const inventory = [...tests].toSorted()
  if (inventory.length === 0) {
    throw new Error('upstream patch tests: 登记补丁没有任何测试文件，拒绝静默通过')
  }
  for (const path of inventory) {
    if (!existsSync(resolve(upstreamDir, path))) {
      throw new Error(`upstream patch tests: 套补丁后测试文件不存在：${path}`)
    }
  }

  console.log(`[upstream-tests] running ${inventory.length} patched specs`)
  for (const path of inventory) console.log(`  - ${path}`)
  const result = spawnPnpmSync(['exec', 'vitest', 'run', ...inventory], {
    cwd: upstreamDir,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`upstream patch tests: vitest failed (exit ${String(result.status)})`)
  }
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
