import { createHash } from 'node:crypto'
import type { Cookies } from 'electron'

const AUTH_COOKIE_NAME = /^dsh-auth-[A-Za-z0-9_-]{43}$/u

/** Upstream binds the signed cookie name to the HTTP authority, including its port. */
export function agentAuthCookieName(url: URL): string {
  return `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
}

/**
 * Keep UI storage in the app's existing session. Only retire old loopback auth
 * cookies: ports are random, but browser cookies are shared across all ports.
 * Without this cleanup repeated launches eventually exceed Node's header limit.
 */
export async function retireAgentCookies(cookies: Pick<Cookies, 'get' | 'remove'>, readyUrl: string): Promise<void> {
  const url = new URL(readyUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('agent navigation requires the loopback HTTP origin')
  }
  const currentName = agentAuthCookieName(url)
  const existing = await cookies.get({ domain: '127.0.0.1' })
  for (const cookie of existing) {
    if (cookie.domain !== '127.0.0.1' || cookie.path !== '/' || cookie.secure
      || !AUTH_COOKIE_NAME.test(cookie.name) || cookie.name === currentName) continue
    await cookies.remove('http://127.0.0.1/', cookie.name)
  }
}

/** Serialize cleanup and navigation so an obsolete generation cannot clear its successor's cookie. */
export function createAgentNavigator(getCookies: () => Pick<Cookies, 'get' | 'remove'>) {
  let pending: Promise<void> = Promise.resolve()
  return (readyUrl: string, isCurrent: () => boolean, load: () => Promise<void>): Promise<void> => {
    const task = pending.catch(() => {}).then(async () => {
      if (!isCurrent()) return
      await retireAgentCookies(getCookies(), readyUrl)
      if (isCurrent()) await load()
    })
    pending = task
    return task
  }
}
