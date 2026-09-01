import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runDshSmoke, validateWebResponse } from '../smoke-dsh'

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
      env: { SMOKE_PID_FILE: pidFile },
    })

    expect(result.status).toBe(200)
    expect(result.port).toBeGreaterThan(0)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(result.bodyBytes).toBeGreaterThan(0)
    expect(readFileSync(pidFile, 'utf8')).toMatch(/^\d+$/u)
  }, 15_000)
})
