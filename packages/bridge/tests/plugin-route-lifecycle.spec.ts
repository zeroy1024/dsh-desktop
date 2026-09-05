import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as FileBrowser from '../../plugins/file-browser/src/index'
import * as Review from '../../plugins/review/src/index'
import * as ArchiveManager from '../../plugins/archive-manager/src/index'
import * as Rewind from '../../plugins/rewind/src/index'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Real public Cordis/WebServer/Connection packages; business data stays in memory. */
async function host() {
  const ctx = new Context()
  contexts.push(ctx)
  let credentialRecord: unknown
  ctx.provide('credentials', {
    async modifyRecord(_key: unknown, modify: (record: unknown) => Promise<unknown>) {
      const next = await modify(credentialRecord)
      if (next !== undefined) credentialRecord = next
      return credentialRecord
    },
  } as never)
  ctx.provide('sessions', { get: () => undefined } as never)
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessionProjections', { register: () => () => {} } as never)
  const rows = new Map<string, { archivedAt: number }>()
  ctx.provide('workspaceRegistry', {
    archivedSessionIds: [],
    unarchiveSession: async () => false,
  } as never)
  ctx.provide('storageDomain', {
    open: async () => ({
      table: () => ({
        get: (key: string) => rows.get(key),
        entries: () => rows.entries(),
        put: async (key: string, value: { archivedAt: number }) => { rows.set(key, value) },
        delete: async (key: string) => rows.delete(key),
      }),
      close: async () => {},
    }),
  } as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(Connection).await()
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/',
    handler: (request, response) => {
      if (ctx.connection.authorizeIndex(request, response)) response.end('authenticated')
    },
  }))
  const login = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
  expect(login.status).toBe(303)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  expect(cookie).toMatch(/^dsh-auth-/u)
  await login.arrayBuffer()
  return { ctx, base, cookie }
}

interface RouteCase {
  path: string
  method: 'GET' | 'POST'
  authenticatedStatus: number
}

const plugins = [
  {
    plugin: FileBrowser,
    routes: [
      { path: '/dsh-file-browser/list', method: 'GET', authenticatedStatus: 400 },
      { path: '/dsh-file-browser/read', method: 'GET', authenticatedStatus: 400 },
    ],
  },
  {
    plugin: Review,
    routes: [
      { path: '/dsh-desktop/review/git', method: 'GET', authenticatedStatus: 400 },
      { path: '/dsh-desktop/review/restore', method: 'POST', authenticatedStatus: 400 },
    ],
  },
  {
    plugin: ArchiveManager,
    routes: [
      { path: '/dsh-desktop/archive-manager/unarchive', method: 'POST', authenticatedStatus: 400 },
      { path: '/dsh-desktop/archive-manager/timestamps', method: 'POST', authenticatedStatus: 200 },
    ],
  },
  {
    plugin: Rewind,
    routes: [{ path: '/dsh-desktop/rewind/execute', method: 'POST', authenticatedStatus: 400 }],
  },
] satisfies Array<{ plugin: { name: string; inject: string[]; apply: unknown }; routes: RouteCase[] }>

describe.each(plugins)('$plugin.name production route composition', ({ plugin, routes }) => {
  it('requires the real browser cookie, rejects foreign origins, and disposes/reinstalls every route', async () => {
    const { ctx, base, cookie } = await host()
    // Preserve the production module's inject and apply; only business services
    // are doubles. The public Cordis fiber owns all effects and route disposal.
    const mount = () => ctx.plugin({ ...plugin, apply: plugin.apply as (context: Context) => void })
    const fiber = mount()
    await fiber.await()

    const request = async (route: RouteCase, auth?: string, origin = base) => {
      const response = await fetch(`${base}${route.path}`, {
        method: route.method,
        headers: { origin, 'content-type': 'application/json', ...(auth === undefined ? {} : { cookie: auth }) },
        ...(route.method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(5_000),
      })
      const body = await response.text()
      return { status: response.status, body }
    }
    for (const route of routes) {
      expect(await request(route), `${route.path}: no cookie`).toMatchObject({ status: 401 })
      expect(await request(route, `${cookie}-tampered`), `${route.path}: invalid signature`).toMatchObject({ status: 401 })
      expect(await request(route, cookie, 'https://untrusted.example'), `${route.path}: foreign origin`).toMatchObject({ status: 403 })
      // Invalid business input is intentional: reaching its 400 (or the empty
      // timestamps result) proves the authenticated production handler ran.
      expect(await request(route, cookie), `${route.path}: authenticated`).toMatchObject({ status: route.authenticatedStatus })
    }
    await fiber.dispose()
    for (const route of routes) expect(await request(route, cookie), `${route.path}: disposed`).toEqual({ status: 404, body: '' })

    const reinstalled = mount()
    await reinstalled.await()
    for (const route of routes) expect(await request(route, cookie), `${route.path}: reinstalled`).toMatchObject({ status: route.authenticatedStatus })
    await reinstalled.dispose()
  })
})
