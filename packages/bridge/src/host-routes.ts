/** Authenticated, fiber-owned routes on the agent's existing HTTP server. */
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'

export interface HostRouteContext {
  effect: Context['effect']
  webServer: Pick<WebServer, 'register'>
  connection: Pick<HostConnectionHandle, 'requestRejection'>
}

/** Keep the upstream trust/cookie policy and registration cleanup in one place. */
export function registerHostRoute(ctx: HostRouteContext, route: WebRoute): () => Promise<void> {
  return ctx.effect(() => ctx.webServer.register({
    ...route,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
        return
      }
      try {
        await route.handler(req, res)
      } catch (error) {
        if (res.destroyed || res.writableEnded) return
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : undefined)
          return
        }
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: 'internal-error' }))
      }
    },
  }), `desktop route: ${route.path}`)
}
