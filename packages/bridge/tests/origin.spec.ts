import { describe, expect, it } from 'vitest'
import { AGENT_HOST, agentOrigin, agentPageUrl, isAgentRendererUrl } from '../src/origin'

describe('agentOrigin / agentPageUrl', () => {
  it('拼 loopback origin，文档 URL 无 query', () => {
    expect(agentOrigin(9)).toBe('http://127.0.0.1:9')
    expect(agentPageUrl(9)).toBe('http://127.0.0.1:9/')
    expect(AGENT_HOST).toBe('127.0.0.1')
  })

  it('拒绝非法端口', () => {
    expect(() => agentOrigin(0)).toThrow(/invalid agent port/)
    expect(() => agentPageUrl(65_536)).toThrow(/invalid agent port/)
    expect(() => agentOrigin(1.5)).toThrow(/invalid agent port/)
  })
})

describe('isAgentRendererUrl', () => {
  it('放行同一代端口的 path/search/hash', () => {
    expect(isAgentRendererUrl('http://127.0.0.1:9/', 9)).toBe(true)
    expect(isAgentRendererUrl('http://127.0.0.1:9/settings?q=1#x', 9)).toBe(true)
  })

  it('拒绝其它端口、host、协议和凭据', () => {
    expect(isAgentRendererUrl('http://127.0.0.1:9/', 8)).toBe(false)
    expect(isAgentRendererUrl('http://localhost:9/', 9)).toBe(false)
    expect(isAgentRendererUrl('https://127.0.0.1:9/', 9)).toBe(false)
    expect(isAgentRendererUrl('dsh://127.0.0.1/', 9)).toBe(false)
    expect(isAgentRendererUrl('http://user@127.0.0.1:9/', 9)).toBe(false)
    expect(isAgentRendererUrl('http://127.0.0.1:9.evil/', 9)).toBe(false)
    expect(isAgentRendererUrl('not a url', 9)).toBe(false)
  })
})
