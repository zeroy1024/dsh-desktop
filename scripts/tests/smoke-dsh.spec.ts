import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStagedPlugins, runDshSmoke, scanStagedPlugins, validateWebResponse } from '../smoke-dsh'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('validateWebResponse', () => {
  it('accepts the dsh HTML shell and records UTF-8 byte length', () => {
    expect(validateWebResponse(
      200,
      'text/html; charset=utf-8',
      '<!doctype html><html><body><div id="root">界面</div></body></html>',
    )).toEqual({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      bodyBytes: Buffer.byteLength('<!doctype html><html><body><div id="root">界面</div></body></html>'),
    })
  })

  it('rejects a successful non-HTML or wrong-shell response', () => {
    expect(() => validateWebResponse(404, 'text/html', '<html><div id="root" /></html>')).toThrow(/HTTP 404/u)
    expect(() => validateWebResponse(200, 'application/json', '{}')).toThrow(/content-type/u)
    expect(() => validateWebResponse(200, 'text/html', '<html><body>missing root</body></html>')).toThrow(/#root/u)
  })
})

describe('runDshSmoke', () => {
  it('boots a CLI, fetches the ready page, and stops it through AgentSupervisor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-fixture-'))
    scratch.push(root)
    const pidFile = join(root, 'pid')
    const cliEntry = join(root, 'fake-cli.mjs')
    mkdirSync(root, { recursive: true })
    writeFileSync(cliEntry, [
      "import { createServer } from 'node:http'",
      "import { writeFileSync } from 'node:fs'",
      'const server = createServer((_request, response) => {',
      "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })",
      "  response.end('<!doctype html><html><body><div id=\"root\"></div></body></html>')",
      '})',
      "writeFileSync(process.env.SMOKE_PID_FILE, String(process.pid))",
      "server.listen(0, '127.0.0.1', () => {",
      "  const address = server.address()",
      "  if (typeof address !== 'object' || address === null) throw new Error('missing address')",
      "  console.log(`dsh web: http://127.0.0.1:${address.port}`)",
      '})',
      "process.once('SIGTERM', () => { server.close(() => process.exit(0)); server.closeAllConnections?.() })",
      "process.once('SIGINT', () => { server.close(() => process.exit(0)); server.closeAllConnections?.() })",
    ].join('\n'))

    const result = await runDshSmoke({
      cliEntry,
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      // CI runs `pnpm test` before `pnpm build`, so the staged plugin closure
      // does not exist yet there; the desktop-profile path is covered by the
      // real `pnpm ci:smoke:dsh` step instead.
      noProfile: true,
      env: { SMOKE_PID_FILE: pidFile },
    })

    expect(result.status).toBe(200)
    expect(result.port).toBeGreaterThan(0)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(result.bodyBytes).toBeGreaterThan(0)
    expect(readFileSync(pidFile, 'utf8')).toMatch(/^\d+$/u)
  }, 15_000)
})

describe('staged plugins resolution', () => {
  function writePlugin(root: string, directory: string, manifest: Record<string, unknown>): void {
    const dir = join(root, directory)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest)}\n`)
  }

  function fixturePlugins(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-staged-fixture-'))
    scratch.push(root)
    return root
  }

  it('collects enabled plugins, skipping dshDesktop.enabled:false and non-package entries', () => {
    const root = fixturePlugins()
    writePlugin(root, 'plugin-a', { name: '@dsh-desktop/plugin-a', version: '0.0.1' })
    writePlugin(root, 'plugin-b', { name: '@dsh-desktop/plugin-b', dshDesktop: { enabled: false } })
    writePlugin(root, 'plugin-c', { name: '@dsh-desktop/plugin-c', dshDesktop: { enabled: true } })
    writeFileSync(join(root, 'not-a-plugin.txt'), 'ignored')

    expect(scanStagedPlugins(root)).toEqual([
      { name: '@dsh-desktop/plugin-a', dir: join(root, 'plugin-a') },
      { name: '@dsh-desktop/plugin-c', dir: join(root, 'plugin-c') },
    ])
  })

  it('sorts plugins by package name and rejects an empty staged closure', () => {
    const root = fixturePlugins()
    expect(() => scanStagedPlugins(root)).toThrow(/staged 插件为空[\s\S]*异常/u)
  })

  it('reports a missing staged closure with the pnpm build prerequisite', () => {
    expect(() => resolveStagedPlugins(join(tmpdir(), 'no-such-staged-plugins'))).toThrow(
      /未找到 staged 插件闭包[\s\S]*请先运行 pnpm build/u,
    )
  })
})
