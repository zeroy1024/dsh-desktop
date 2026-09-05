import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const patches = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
  { schema: entryListSchema }) as PatchOptions[]
const nativeName = '@deepseek-ai/dsh-session-query-sqlite'
const projectedName = '@dsh-desktop/rewind/session-query'
const base = [
  { id: 'session-turn-outline', name: '@deepseek-ai/dsh-session-turn-outline' },
  { id: 'session-query-sqlite', name: nativeName, config: { path: ':memory:', openAt: 'never' } },
]

describe('rewind provider configuration using the published Include composer', () => {
  it('activates the replacement under the existing identity and retains search opt-in', () => {
    const warn = vi.fn()
    const result = applyEntryPatches(base, patches, warn)
    expect(result.find(row => row.id === 'session-query-sqlite')).toEqual({
      ...base[1], name: projectedName,
    })
    expect(result.find(row => row.id === 'session-turn-outline')?.disabled).toBe(true)
    expect(result.filter(row => row.name === projectedName)).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('preserves earlier configuration, later user overrides, and reusable input layers', () => {
    const config = { path: '/tmp/user-search.db', openAt: 'first-search', maxLimit: 37 }
    const configured = base.map(row => row.id === 'session-query-sqlite' ? { ...row, config, disabled: true } : row)
    const before = structuredClone({ configured, patches })
    const warn = vi.fn()
    const result = applyEntryPatches(configured, patches, warn)
    expect(result.find(row => row.id === 'session-query-sqlite')).toMatchObject({ name: projectedName, config, disabled: true })
    const user = { id: 'session-query-sqlite', config: { path: 'later.db', openAt: 'never' }, disabled: false }
    const later = applyEntryPatches(configured, [...patches, user], warn)
    expect(later.find(row => row.id === user.id)).toMatchObject({ ...user, name: projectedName })
    expect(applyEntryPatches(configured, patches, warn)).toEqual(result)
    expect({ configured, patches }).toEqual(before)
    expect(warn).not.toHaveBeenCalled()
  })
})
