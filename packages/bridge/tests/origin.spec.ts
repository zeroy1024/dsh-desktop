import { describe, expect, it } from 'vitest'
import {
  DSH_ORIGIN,
  headersForAgent,
  isAgentEventSocket,
  toAgentHttpUrl,
  toAgentWsUrl,
} from '../src/origin'
import { injectWsShim } from '../src/ws-shim'

describe('toAgentHttpUrl', () => {
  it('映射 dsh:// 到 agent HTTP 并补 token', () => {
    expect(
      toAgentHttpUrl(`${DSH_ORIGIN}/api/x`, { port: 9, token: 't' }),
    ).toBe('http://127.0.0.1:9/api/x?token=t')
  })

  it('拒绝非本协议', () => {
    expect(() => toAgentHttpUrl('https://example.com/', { port: 1, token: null })).toThrow(/refused/)
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
})

describe('injectWsShim', () => {
  it('插进 head 且幂等', () => {
    const once = injectWsShim('<html><head><title>x</title></head></html>')
    expect(once).toContain('__dshSockets')
    expect(injectWsShim(once)).toBe(once)
  })
})
