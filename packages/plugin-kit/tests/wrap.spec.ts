import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
})
