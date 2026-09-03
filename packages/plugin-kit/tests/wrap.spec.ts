import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildClientBundle, wrapClientFactory } from '../src/client-bundle'

const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs.length = 0
})

describe('wrapClientFactory', () => {
  it('包进 ModuleLoader 工厂并返回 module.exports', () => {
    const wrapped = wrapClientFactory('@dsh-desktop/hello-panel', 'exports.apply = function apply() {}')
    expect(wrapped).toContain('window.__ModuleLoader__.load({ id: "@dsh-desktop/hello-panel"')
    expect(wrapped).toContain('factory: (require) => {')
    expect(wrapped).toContain('return module.exports; } });')
    const stripped = wrapClientFactory('@dsh-desktop/hello-panel', 'exports.x = 1\n//# sourceMappingURL=client.js.map\n')
    expect(stripped).not.toContain('sourceMappingURL')
  })

  it('把 CSS Modules 与全局 CSS 编译并内联进插件拥有的 style 标签', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'plugin-kit-css-'))
    scratchDirs.push(scratch)
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'client-with-css')
    const outfile = join(scratch, 'client.js')
    await buildClientBundle({
      id: '@dsh-desktop/css-fixture',
      entry: join(fixtures, 'index.ts'),
      outfile,
    })

    const bundle = readFileSync(outfile, 'utf8')
    expect(bundle).toContain('data-plugin-css')
    expect(bundle).toContain('@dsh-desktop/css-fixture/client.css')
    expect(bundle).toContain('background: rebeccapurple')
    expect(bundle).toContain('font-weight: 700')
  })

  it('兑现包声明的 dsh.client.external：声明词条保持外部 require 不进包', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'plugin-kit-declared-ext-'))
    scratchDirs.push(scratch)
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({
        name: '@dsh-desktop/declared-ext-fixture',
        version: '0.0.1',
        dsh: { client: { external: ['@dsh-desktop/fake-shared/client'] } },
      }),
    )
    writeFileSync(
      join(scratch, 'entry.ts'),
      [
        "import { x } from '@dsh-desktop/fake-shared/client'",
        "import { useEffect } from 'react'",
        'console.log(x, useEffect)',
      ].join('\n'),
    )

    const outfile = join(scratch, 'client.js')
    await buildClientBundle({
      id: '@dsh-desktop/declared-ext-fixture',
      entry: join(scratch, 'entry.ts'),
      outfile,
    })

    const bundle = readFileSync(outfile, 'utf8')
    // 声明词条与平台基线词条都必须保持外部 require、不进包。
    expect(bundle).toContain('require("@dsh-desktop/fake-shared/client")')
    expect(bundle).toContain('require("react")')
    // 产物只含工厂包装的引用，不含 react 源码特征串。
    expect(bundle).not.toContain('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED')
  })
})
