import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSecurityHooks, isAllowedAgentNavigation } from '../src/main/security'

/**
 * electron 模块的结构 Mock：app.on 只收集 web-contents-created 监听，
 * 测试手动触发；shell.openExternal 同步返回已 resolve 的 Promise，
 * 与 security.ts 里 `void shell.openExternal(url).catch(...)` 的用法兼容。
 */
const electronMock = vi.hoisted(() => {
  const appListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    appListeners,
    session: {
      defaultSession: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onHeadersReceived: vi.fn() },
      },
    },
    shell: { openExternal: vi.fn(async () => undefined) },
  }
})

vi.mock('electron', () => ({
  app: {
    on(event: string, listener: (...args: unknown[]) => void): void {
      ;(electronMock.appListeners[event] ??= []).push(listener)
    },
  },
  session: electronMock.session,
  shell: electronMock.shell,
}))

/** 结构 Fake：只承接 security.ts 在 web-contents-created 里挂的钩子。 */
class FakeWebContents {
  readonly handlers = new Map<string, (...args: unknown[]) => void>()
  setWindowOpenHandler = vi.fn()

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.set(event, listener)
  }
}

/** 触发一次 web-contents-created，返回挂好钩子的 FakeWebContents。 */
function createdContents(): FakeWebContents {
  const contents = new FakeWebContents()
  for (const listener of electronMock.appListeners['web-contents-created'] ?? []) {
    listener({}, contents)
  }
  return contents
}

describe('isAllowedAgentNavigation', () => {
  const port = 41234
  const agentUrl = `http://127.0.0.1:${port}/chat?session=1`

  it('agent origin 放行', () => {
    expect(isAllowedAgentNavigation(agentUrl, port)).toBe(true)
    expect(isAllowedAgentNavigation(`http://127.0.0.1:${port}/`, port)).toBe(true)
  })

  it('端口不符拒绝', () => {
    expect(isAllowedAgentNavigation(`http://127.0.0.1:${port + 1}/`, port)).toBe(false)
  })

  it('agent 未就绪（port 为 null）拒绝', () => {
    expect(isAllowedAgentNavigation(agentUrl, null)).toBe(false)
  })

  it('外部 URL / 非法 URL 拒绝', () => {
    expect(isAllowedAgentNavigation('https://evil.example/', port)).toBe(false)
    expect(isAllowedAgentNavigation('file:///etc/passwd', port)).toBe(false)
    expect(isAllowedAgentNavigation('not a url', port)).toBe(false)
  })
})

describe('installSecurityHooks 导航钩子', () => {
  const port = 41234

  afterEach(() => {
    electronMock.shell.openExternal.mockClear()
  })

  it('web-contents-created 同时挂 will-navigate 与 will-redirect', () => {
    installSecurityHooks(() => port)
    const contents = createdContents()
    expect(contents.handlers.has('will-navigate')).toBe(true)
    expect(contents.handlers.has('will-redirect')).toBe(true)
  })

  it('will-redirect：外部 URL 被 preventDefault 并交给系统浏览器', () => {
    installSecurityHooks(() => port)
    const contents = createdContents()
    const event = { preventDefault: vi.fn() }
    contents.handlers.get('will-redirect')!(event, 'https://evil.example/')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(electronMock.shell.openExternal).toHaveBeenCalledWith('https://evil.example/')
  })

  it('will-redirect：agent origin 重定向放行', () => {
    installSecurityHooks(() => port)
    const contents = createdContents()
    const event = { preventDefault: vi.fn() }
    contents.handlers.get('will-redirect')!(event, `http://127.0.0.1:${port}/chat?session=1`)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled()
  })

  it('will-navigate 与 will-redirect 判定一致：外部拒绝、agent 放行', () => {
    installSecurityHooks(() => port)
    const contents = createdContents()
    for (const hook of ['will-navigate', 'will-redirect'] as const) {
      const blocked = { preventDefault: vi.fn() }
      contents.handlers.get(hook)!(blocked, 'https://evil.example/')
      expect(blocked.preventDefault).toHaveBeenCalledTimes(1)
      const allowed = { preventDefault: vi.fn() }
      contents.handlers.get(hook)!(allowed, `http://127.0.0.1:${port}/`)
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }
    expect(electronMock.shell.openExternal).toHaveBeenCalledTimes(2)
  })

  it('agent 未就绪（port 为 null）：即便是 agent 地址也拒绝', () => {
    installSecurityHooks(() => null)
    const contents = createdContents()
    for (const hook of ['will-navigate', 'will-redirect'] as const) {
      const event = { preventDefault: vi.fn() }
      contents.handlers.get(hook)!(event, `http://127.0.0.1:${port}/`)
      expect(event.preventDefault).toHaveBeenCalledTimes(1)
    }
  })
})