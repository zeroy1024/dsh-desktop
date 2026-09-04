import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stagePlugins } from '../stage-plugins'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

interface Fixture {
  pluginsDir: string
  cliModulesDir: string
  appManifestPath: string
}

/** 仿 smoke-dsh.spec 的假 staged 树：两个插件，其一 dshDesktop.enabled:false。 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stage-fixture-'))
  scratch.push(root)
  const fx: Fixture = {
    pluginsDir: join(root, 'plugins'),
    cliModulesDir: join(root, 'cli-modules'),
    appManifestPath: join(root, 'app-package.json'),
  }
  mkdirSync(join(fx.cliModulesDir, '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(fx.cliModulesDir, '@deepseek-ai', 'dsh', 'package.json'), '{}\n')
  writeFileSync(fx.appManifestPath, `${JSON.stringify({ name: 'app', version: '0.0.7' }, null, 2)}\n`)
  for (const [name, enabled] of [['plugin-a', undefined], ['plugin-b', false]] as Array<[string, boolean | undefined]>) {
    const dir = join(fx.pluginsDir, name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), 'export {}\n')
    writeFileSync(join(dir, 'lib', 'client.js'), 'export {}\n')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `@dsh-desktop/${name}`,
      version: '0.0.1',
      files: ['lib/index.js', 'lib/client.js', 'cordis.patch.yml'],
      ...(enabled === false ? { dshDesktop: { enabled: false } } : {}),
    }, null, 2)}\n`)
  }
  return fx
}

function stage(fx: Fixture): void {
  stagePlugins({ ...fx })
}

describe('stagePlugins version alignment', () => {
  it('writes the app version into staged manifests, leaving sources untouched', () => {
    const fx = fixture()
    stage(fx)
    const staged = JSON.parse(
      readFileSync(join(fx.cliModulesDir, '@dsh-desktop', 'plugin-a', 'package.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown }
    expect(staged).toMatchObject({ name: '@dsh-desktop/plugin-a', version: '0.0.7' })
    const source = JSON.parse(
      readFileSync(join(fx.pluginsDir, 'plugin-a', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    expect(source).toMatchObject({ version: '0.0.1' })
    // enabled:false 的插件不进 staged 闭包
    expect(existsSync(join(fx.cliModulesDir, '@dsh-desktop', 'plugin-b'))).toBe(false)
  })

  it('rejects a missing app version', () => {
    const fx = fixture()
    writeFileSync(fx.appManifestPath, `${JSON.stringify({ name: 'app' }, null, 2)}\n`)
    expect(() => stage(fx)).toThrow(/version/u)
  })
})