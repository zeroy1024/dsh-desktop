import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { stageRuntimeArchive } from '../stage-runtime-archive'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('keeps packaged skill Markdown loadable while pruning README and source maps', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-assets-'))
  directories.push(root)
  const sourceDir = join(root, 'runtime')
  const files = {
    'node_modules/@deepseek-ai/dsh/lib/bin.js': 'export {}',
    'node_modules/@dsh-desktop/plugin-fixture/package.json': '{"name":"@dsh-desktop/plugin-fixture"}',
    'node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.md': '# Badge skill\nUse this bundled resource.\n',
    'node_modules/@deepseek-ai/dsh-skill-badge/README.md': '# Documentation',
    'node_modules/@deepseek-ai/dsh-skill-badge/lib/index.js.map': '{}',
  }
  for (const [relative, body] of Object.entries(files)) {
    const file = join(sourceDir, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  const archive = stageRuntimeArchive({ sourceDir, outputDir: join(root, 'output') })
  const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
  const resource = 'node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.md'
  expect(listing).toContain(resource)
  expect(listing).not.toContain('README.md')
  expect(listing).not.toContain('index.js.map')
  expect(execFileSync('tar', ['-xOf', archive, `./${resource}`], { encoding: 'utf8' })).toBe(files[resource])
})
