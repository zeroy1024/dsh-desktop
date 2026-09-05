import type { Cookie } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { agentAuthCookieName, createAgentNavigator, retireAgentCookies } from '../src/main/agent-navigation'

function authCookie(port: number): Cookie {
  return {
    name: agentAuthCookieName(new URL(`http://127.0.0.1:${port}/`)),
    value: 'signed-cookie', domain: '127.0.0.1', path: '/',
    secure: false, httpOnly: true, session: false, sameSite: 'strict',
  }
}

function cookieStore(initial: Cookie[]) {
  const all = [...initial]
  return {
    all,
    get: vi.fn(async () => [...all]),
    remove: vi.fn(async (_url: string, name: string) => {
      const index = all.findIndex(cookie => cookie.name === name && cookie.domain === '127.0.0.1' && cookie.path === '/')
      if (index !== -1) all.splice(index, 1)
    }),
  }
}

describe('agent authentication across launches', () => {
  it('retires accumulated auth cookies while keeping the current cookie and other app state', async () => {
    const current = authCookie(51234)
    const unrelated = [
      { ...authCookie(52001), name: 'theme' },
      { ...authCookie(52002), domain: 'example.com' },
      { ...authCookie(52003), path: '/other-service' },
      { ...authCookie(52004), name: 'dsh-auth-custom-service' },
    ]
    const stale = Array.from({ length: 100 }, (_, index) => authCookie(49000 + index))
    const cookies = cookieStore([...stale, current, ...unrelated])
    await retireAgentCookies(cookies, 'http://127.0.0.1:51234/?token=fresh')
    expect(cookies.remove).toHaveBeenCalledTimes(100)
    expect(cookies.all).toEqual([current, ...unrelated])
    // Reopening the same running generation does not revoke its valid cookie.
    await retireAgentCookies(cookies, 'http://127.0.0.1:51234/?token=fresh')
    expect(cookies.remove).toHaveBeenCalledTimes(100)
  })

  it('serializes cleanup with loadURL and skips a generation superseded during cleanup', async () => {
    let generation = 1
    const cookies = cookieStore([authCookie(49000)])
    let resolveRead!: (cookies: Cookie[]) => void
    cookies.get.mockImplementationOnce(() => new Promise(resolvePromise => { resolveRead = resolvePromise }))
    const navigate = createAgentNavigator(() => cookies)
    const oldLoad = vi.fn(async () => {})
    const newLoad = vi.fn(async () => { cookies.all.push(authCookie(50002)) })
    const oldTask = navigate('http://127.0.0.1:50001/?token=old', () => generation === 1, oldLoad)
    await vi.waitFor(() => expect(cookies.get).toHaveBeenCalledTimes(1))
    generation = 2
    const newTask = navigate('http://127.0.0.1:50002/?token=new', () => generation === 2, newLoad)
    expect(newLoad).not.toHaveBeenCalled()
    resolveRead([...cookies.all])
    await Promise.all([oldTask, newTask])
    expect(oldLoad).not.toHaveBeenCalled()
    expect(newLoad).toHaveBeenCalledOnce()
    expect(cookies.all).toEqual([authCookie(50002)])
  })

  it('propagates cleanup failure before navigation and permits a later retry', async () => {
    const cookies = cookieStore([authCookie(49000)])
    cookies.remove.mockRejectedValueOnce(new Error('cookie storage unavailable'))
    const navigate = createAgentNavigator(() => cookies)
    const load = vi.fn(async () => {})
    await expect(navigate('http://127.0.0.1:50001/', () => true, load)).rejects.toThrow('cookie storage unavailable')
    expect(load).not.toHaveBeenCalled()
    await navigate('http://127.0.0.1:50001/', () => true, load)
    expect(load).toHaveBeenCalledOnce()
  })
})
