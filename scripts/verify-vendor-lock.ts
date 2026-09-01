/**
 * Verify the reproducible part of vendor/dsh-cli/pnpm-lock.yaml.
 *
 * Local tarballs contain generated source maps whose byte integrity can change
 * between otherwise equivalent upstream builds. Those local integrity values
 * and the peer-context hashes derived from them are intentionally excluded.
 * Registry package identities, registry integrity, install policy, overrides,
 * and importer specifiers must still match the tracked lockfile exactly.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { spawnCommandSync } from './command'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = resolve(rootDir, 'vendor', 'dsh-cli', 'pnpm-lock.yaml')
const trackedLockPath = 'vendor/dsh-cli/pnpm-lock.yaml'

type Mapping = Record<string, unknown>

function mapping(value: unknown): Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Mapping
    : {}
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Mapping)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sorted(entry)]),
  )
}

function dependencySpecifiers(importer: unknown): Mapping {
  const source = mapping(importer)
  const result: Mapping = {}
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = mapping(source[section])
    if (Object.keys(dependencies).length === 0) continue
    result[section] = Object.fromEntries(Object.entries(dependencies).map(([name, value]) => {
      const detail = mapping(value)
      return [name, typeof detail.specifier === 'string' ? detail.specifier : value]
    }))
  }
  return result
}

function isLocalPackage(key: string, value: unknown): boolean {
  if (key.includes('@file:') || key.startsWith('file:')) return true
  const resolution = mapping(mapping(value).resolution)
  return typeof resolution.tarball === 'string' && resolution.tarball.startsWith('file:')
}

export interface VendorLockContract {
  lockfileVersion: unknown
  settings: unknown
  overrides: unknown
  patchedDependencies: unknown
  importers: Mapping
  registryPackages: Mapping
  snapshots: Array<{ key: string; value: unknown }>
}

function normalizePeerHashes(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(/\b[0-9a-f]{32}\b/gu, '<peer-hash>')
  if (Array.isArray(value)) return value.map(normalizePeerHashes)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Mapping).map(([key, entry]) => [key, normalizePeerHashes(entry)]),
  )
}

/** Project the stable, registry-facing contract out of a pnpm lockfile. */
export function vendorLockContract(source: string): VendorLockContract {
  const lock = mapping(yaml.load(source))
  const importers = Object.fromEntries(
    Object.entries(mapping(lock.importers)).map(([name, importer]) => [
      name,
      dependencySpecifiers(importer),
    ]),
  )
  const registryPackages = Object.fromEntries(
    Object.entries(mapping(lock.packages)).filter(([key, value]) => !isLocalPackage(key, value)),
  )
  // Peer-context ids are content hashes. Local tarball byte drift changes
  // those ids even when the resolved graph is identical, so normalize only
  // the ids while retaining every snapshot edge and duplicate context.
  const snapshots = Object.entries(mapping(lock.snapshots))
    .map(([key, value]) => ({
      key: normalizePeerHashes(key) as string,
      value: sorted(normalizePeerHashes(value)),
    }))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return sorted({
    lockfileVersion: lock.lockfileVersion,
    settings: lock.settings,
    overrides: lock.overrides,
    patchedDependencies: lock.patchedDependencies,
    importers,
    registryPackages,
    snapshots,
  }) as VendorLockContract
}

function trackedLockSource(): string {
  const result = spawnCommandSync('git', ['show', `HEAD:${trackedLockPath}`], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`无法读取 HEAD:${trackedLockPath}：${result.stderr.trim()}`)
  }
  return result.stdout
}

function fingerprint(contract: VendorLockContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

function main(): void {
  const tracked = vendorLockContract(trackedLockSource())
  const generated = vendorLockContract(readFileSync(lockPath, 'utf8'))
  const trackedJson = JSON.stringify(tracked)
  const generatedJson = JSON.stringify(generated)
  if (trackedJson !== generatedJson) {
    throw new Error(
      'vendor lock 的 registry 契约发生漂移；请检查依赖变化并提交重新生成的 '
        + `${trackedLockPath}（tracked=${fingerprint(tracked)}, generated=${fingerprint(generated)}）`,
    )
  }
  console.log(`[vendor-lock] registry contract OK ${fingerprint(generated)}`)
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
