import { describe, expect, it } from 'vitest'
import {
  DSH_ORIGIN,
  headersForAgent,
  isAgentEventSocket,
  isDshRendererUrl,
  parseAgentEventPath,
  toAgentHttpUrl,
  toAgentWsUrl,
} from '../src/origin'
import { injectWsShim } from '../src/ws-shim'

describe('toAgentHttpUrl', () => {
  it('映射 dsh:// 到 agent HTTP 并补 token', () => {
    expect(
      toAgentHttpUrl(`${DSH_ORIGIN}/api/x`, { port: 9, token: 't' }),
    ).toBe('http://127.0.0.1:9/api/x?token=t')
    expect(toAgentHttpUrl(`${DSH_ORIGIN}/api/x?token=renderer`, { port: 9, token: 'main' }))
      .toBe('http://127.0.0.1:9/api/x?token=main')
  })

  it('拒绝非本协议', () => {
    expect(() => toAgentHttpUrl('https://example.com/', { port: 1, token: null })).toThrow(/refused/)
    expect(() => toAgentHttpUrl(`${DSH_ORIGIN}.evil/`, { port: 1, token: null })).toThrow(/refused/)
    expect(() => toAgentHttpUrl(`${DSH_ORIGIN}/`, { port: 0, token: null })).toThrow(/invalid agent port/)
  })
})

describe('renderer URL boundary', () => {
  it('精确匹配 scheme、host、port 和凭据', () => {
    expect(isDshRendererUrl(`${DSH_ORIGIN}/settings?q=1`)).toBe(true)
    expect(isDshRendererUrl(`${DSH_ORIGIN}.evil/`)).toBe(false)
    expect(isDshRendererUrl('dsh://user@127.0.0.1/')).toBe(false)
    expect(isDshRendererUrl('dsh://127.0.0.1:9/')).toBe(false)
    expect(isDshRendererUrl('not a url')).toBe(false)
  })
})

describe('toAgentWsUrl', () => {
  it('把事件路径编成 ws://', () => {
    expect(toAgentWsUrl('/api/events.mux', { port: 8, token: 'k' })).toBe(
      'ws://127.0.0.1:8/api/events.mux?token=k',
    )
  })
})

describe('headersForAgent', () => {
  it('剥掉 Origin 与 sec-fetch-*', () => {
    const headers = new Headers({
      origin: 'dsh://127.0.0.1',
      'sec-fetch-site': 'cross-site',
      accept: 'application/json',
    })
    const out = headersForAgent(headers)
    expect(out.get('origin')).toBeNull()
    expect(out.get('sec-fetch-site')).toBeNull()
    expect(out.get('accept')).toBe('application/json')
  })
})

describe('isAgentEventSocket', () => {
  it('只认 mux/host 下行', () => {
    expect(isAgentEventSocket('/api/events.mux')).toBe(true)
    expect(isAgentEventSocket('/api/events.host')).toBe(true)
    expect(isAgentEventSocket('/api/sessions')).toBe(false)
  })

  it('规范化 IPC 路径并拒绝跨 origin/片段/非事件接口', () => {
    expect(parseAgentEventPath('/api/events.mux?cursor=1')).toBe('/api/events.mux?cursor=1')
    expect(parseAgentEventPath('//evil.example/api/events.mux')).toBeNull()
    expect(parseAgentEventPath('/api/events.mux#fragment')).toBeNull()
    expect(parseAgentEventPath('/api/sessions')).toBeNull()
    expect(parseAgentEventPath({ path: '/api/events.mux' })).toBeNull()
  })
})

describe('injectWsShim', () => {
  it('插进 head 且幂等', () => {
    const once = injectWsShim('<html><head><title>x</title></head></html>')
    expect(once).toContain('__dshSockets')
    expect(injectWsShim(once)).toBe(once)
  })
})
