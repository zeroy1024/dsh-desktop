import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { iconAssetOf } from '../src/client/lang.ts'

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')

describe('ExpUI file icon mapping', () => {
  it('maps common file extensions to static asset IDs', () => {
    const cases: Array<[string, string]> = [
      ['README.md', 'markdown'], ['component.mdx', 'markdown'],
      ['package.json', 'json'], ['settings.yaml', 'yaml'], ['settings.toml', 'toml'],
      ['src/index.ts', 'typeScript'], ['src/index.tsx', 'typeScript'], ['src/index.mts', 'typeScript'],
      ['src/index.js', 'javaScript'], ['src/index.jsx', 'javaScript'],
      ['styles.scss', 'css'], ['index.html', 'html'], ['document.xml', 'xml'],
      ['schema.xsd', 'xsd'], ['service.wsdl', 'wsdl'], ['page.xhtml', 'xhtml'],
      ['run.zsh', 'shell'], ['tool.py', 'python'], ['main.go', 'go'], ['main.rs', 'rust'],
      ['main.c', 'c'], ['main.h', 'h'], ['main.cpp', 'cpp'], ['Program.cs', 'Csharp'],
      ['Main.java', 'java'], ['Main.class', 'javaClass'], ['query.sql', 'sql'], ['app.vue', 'vue'],
      ['picture.avif', 'image'], ['payload.wasm', 'binaryData'], ['notes.txt', 'text'],
      ['bundle.zip', 'archive'], ['font.woff2', 'font'], ['main.tf', 'terraform'],
    ]
    for (const [name, expected] of cases) expect(iconAssetOf(name)).toBe(expected)
  })

  it('maps special basenames and paths case-insensitively', () => {
    expect(iconAssetOf('Dockerfile.dev')).toBe('docker')
    expect(iconAssetOf('src/Makefile')).toBe('config')
    expect(iconAssetOf('/workspace/.env.local')).toBe('config')
    expect(iconAssetOf('/workspace/.editorconfig')).toBe('editorConfig')
    expect(iconAssetOf('/workspace/.gitignore')).toBe('gitignore')
    expect(iconAssetOf('/workspace/Jenkinsfile')).toBe('jenkins')
    expect(iconAssetOf('/workspace/WORKSPACE.bazel')).toBe('bazel')
    expect(iconAssetOf('README')).toBe('markdown')
    expect(iconAssetOf('docs/CHANGELOG')).toBe('markdown')
    expect(iconAssetOf('LICENSE.txt')).toBe('text')
    expect(iconAssetOf('src/README.MD')).toBe('markdown')
  })

  it('always returns the explicit unknown asset for unsupported file kinds', () => {
    for (const name of [
      'Cargo.lock', 'package.lockb', 'package-lock.json', 'pnpm-lock.yaml',
      'tsconfig', 'file.custom',
    ]) {
      expect(iconAssetOf(name)).toBe('unknown')
    }
  })

  it('keeps the renderer free of host folder icons and hand-drawn SVG fallback', () => {
    const source = readFileSync(join(clientRoot, 'FileIcon.tsx'), 'utf8')
    expect(source).not.toContain('IconFolder')
    expect(source).not.toContain('<svg')
    expect(source).not.toContain('css.fallback')
    expect(source).toContain("dir ? 'folder' : iconAssetOf(name)")
  })
})
