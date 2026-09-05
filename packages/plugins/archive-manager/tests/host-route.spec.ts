import { createServer, type Server } from 'node:http'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  handleUnarchiveRequest, isSameOrigin, UNARCHIVE_PATH, unarchiveSession, UnsupportedRegistryError,
  type UnarchiveRegistry,
} from '../src/index.ts'

/** Public API double; queue and persistence semantics are covered on the real registry. */
function fakeRegistry(archivedSessionIds: string[]) {
  let archived = archivedSessionIds as unknown as UnarchiveRegistry['archivedSessionIds']
  return {
    get archivedSessionIds() { return archived },
    unarchiveSession: vi.fn<UnarchiveRegistry['unarchiveSession']>(async sessionId => {
      if (!archived.includes(sessionId)) return false
      archived = archived.filter(id => id !== sessionId)
      return true
    }),
  }
}

/** 把 handleUnarchiveRequest 挂到真 http server 上，返回 base URL。 */
async function startServer(registry: UnarchiveRegistry): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void handleUnarchiveRequest(req, res, registry)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => { server.close(() => resolve()) }),
  }
}

function post(base: string, path: string, body: unknown, origin?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify(body),
  })
}

const servers: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(servers.map(server => server.close()))
})

describe('isSameOrigin', () => {
  it('accepts an origin matching the host header', () => {
    expect(isSameOrigin('http://127.0.0.1:49152', '127.0.0.1:49152')).toBe(true)
    expect(isSameOrigin('http://localhost:49152', 'localhost:49152')).toBe(true)
  })
  it('rejects a rebinding-shaped request where Origin equals a non-loopback Host', () => {
    // DNS rebinding：攻击域解析到 127.0.0.1，Origin 与 Host 同为攻击域。
    expect(isSameOrigin('http://evil.example:8080', 'evil.example:8080')).toBe(false)
  })
  it('rejects missing, malformed, cross-port, credential-bearing, and non-http origins', () => {
    expect(isSameOrigin(undefined, '127.0.0.1:1')).toBe(false)
    expect(isSameOrigin('http://127.0.0.1:1', undefined)).toBe(false)
    expect(isSameOrigin('not a url', '127.0.0.1:1')).toBe(false)
    expect(isSameOrigin('http://127.0.0.1:9999', '127.0.0.1:1')).toBe(false)
    expect(isSameOrigin('http://user:pass@127.0.0.1:1', '127.0.0.1:1')).toBe(false)
    expect(isSameOrigin('file:///etc/passwd', '127.0.0.1:1')).toBe(false)
  })
})

describe('unarchiveSession', () => {
  it('delegates to the public method and reads the committed public snapshot', async () => {
    const registry = fakeRegistry(['a', 'b', 'c'])
    await expect(unarchiveSession(registry, 'b')).resolves.toEqual({
      archivedSessionIds: ['a', 'c'],
      changed: true,
    })
    expect(registry.unarchiveSession).toHaveBeenCalledExactlyOnceWith('b')
    expect(registry.archivedSessionIds).toEqual(['a', 'c'])
  })

  it('is a no-op for an id outside the archive set', async () => {
    const registry = fakeRegistry(['a'])
    await expect(unarchiveSession(registry, 'x')).resolves.toEqual({
      archivedSessionIds: ['a'],
      changed: false,
    })
    expect(registry.unarchiveSession).toHaveBeenCalledExactlyOnceWith('x')
  })

  it('rejects with UnsupportedRegistryError when the public API is missing', async () => {
    await expect(unarchiveSession({} as UnarchiveRegistry, 'a')).rejects.toBeInstanceOf(UnsupportedRegistryError)
  })

  it('propagates a public operation failure without synthesizing success', async () => {
    const registry = fakeRegistry(['a'])
    registry.unarchiveSession.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(unarchiveSession(registry, 'a')).rejects.toThrow('storage unavailable')
    expect(registry.archivedSessionIds).toEqual(['a'])
  })
})

describe('unarchive route', () => {
  it('restores a session over http and persists through the registry', async () => {
    const registry = fakeRegistry(['keep', 'gone'])
    const server = await startServer(registry)
    servers.push(server)

    const response = await post(server.base, UNARCHIVE_PATH, { sessionId: 'gone' }, server.base)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      changed: true,
      archivedSessionIds: ['keep'],
    })
  })

  it('answers 405 for non-POST and 403 for foreign origins before touching the registry', async () => {
    const registry = fakeRegistry(['a'])
    const server = await startServer(registry)
    servers.push(server)

    const method = await fetch(`${server.base}${UNARCHIVE_PATH}`)
    expect(method.status).toBe(405)

    const foreign = await post(server.base, UNARCHIVE_PATH, { sessionId: 'a' }, 'http://127.0.0.1:9999')
    expect(foreign.status).toBe(403)
    expect(registry.unarchiveSession).not.toHaveBeenCalled()
  })

  it('answers 415/400 for malformed requests', async () => {
    const registry = fakeRegistry(['a'])
    const server = await startServer(registry)
    servers.push(server)

    const wrongType = await fetch(`${server.base}${UNARCHIVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: server.base },
      body: 'x',
    })
    expect(wrongType.status).toBe(415)

    const badJson = await fetch(`${server.base}${UNARCHIVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.base },
      body: '{nope',
    })
    expect(badJson.status).toBe(400)

    const missingId = await post(server.base, UNARCHIVE_PATH, {}, server.base)
    expect(missingId.status).toBe(400)
  })

  it('answers 500 when the public operation fails', async () => {
    const registry = fakeRegistry(['a'])
    registry.unarchiveSession.mockRejectedValueOnce(new Error('storage unavailable'))
    const server = await startServer(registry)
    servers.push(server)
    const response = await post(server.base, UNARCHIVE_PATH, { sessionId: 'a' }, server.base)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'internal-error' })
    expect(registry.archivedSessionIds).toEqual(['a'])
  })

  it('answers 501 when the public API is missing', async () => {
    const server = await startServer({} as UnarchiveRegistry)
    servers.push(server)
    const response = await post(server.base, UNARCHIVE_PATH, { sessionId: 'a' }, server.base)
    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'unsupported-host' })
  })
})
