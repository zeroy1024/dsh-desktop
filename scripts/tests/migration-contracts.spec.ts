import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
it('keeps package metadata separate from Cordis service inject declarations', () => {
  const plugins = resolve(root, 'packages/plugins')
  for (const name of readdirSync(plugins)) {
    const manifest = JSON.parse(readFileSync(resolve(plugins, name, 'package.json'), 'utf8')) as {
      dsh?: { client?: { inject?: string[] } }
    }
    for (const dependency of manifest.dsh?.client?.inject ?? []) {
      expect(dependency, `${name}: dsh.client.inject requires package names`).toMatch(/^@(?:deepseek-ai|dsh-desktop)\//u)
    }
  }
})

it('registers every patch artifact exactly once so obsolete queues cannot masquerade as active', () => {
  const patchesDir = resolve(root, 'patches')
  const registry = yaml.load(readFileSync(resolve(patchesDir, 'patches.yml'), 'utf8')) as {
    patches: { file: string; reason: string }[]
  }
  const files = registry.patches.map(entry => entry.file)
  expect(new Set(files).size).toBe(files.length)
  expect(files.toSorted()).toEqual(readdirSync(patchesDir).filter(name => name.endsWith('.patch')).toSorted())
  for (const entry of registry.patches) expect(entry.reason.trim().length).toBeGreaterThan(0)
})
