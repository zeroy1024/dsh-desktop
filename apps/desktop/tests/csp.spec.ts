import { describe, expect, it } from 'vitest'
import { AGENT_CSP, agentDocumentCsp } from '../src/main/security'

describe('agentDocumentCsp', () => {
  const port = 41234

  it('agent origin 的主文档钉 CSP', () => {
    const csp = agentDocumentCsp('mainFrame', `http://127.0.0.1:${port}/chat?session=1`, port)
    expect(csp).toBe(AGENT_CSP)
  })

  it('非主文档（脚本/样式/图片等子资源）不钉', () => {
    expect(agentDocumentCsp('script', `http://127.0.0.1:${port}/assets/index.js`, port)).toBeNull()
    expect(agentDocumentCsp('stylesheet', `http://127.0.0.1:${port}/assets/index.css`, port)).toBeNull()
    expect(agentDocumentCsp('image', `http://127.0.0.1:${port}/favicon.ico`, port)).toBeNull()
    expect(agentDocumentCsp('subFrame', `http://127.0.0.1:${port}/`, port)).toBeNull()
  })

  it('非 agent 来源不钉', () => {
    expect(agentDocumentCsp('mainFrame', 'https://evil.example', port)).toBeNull()
    expect(agentDocumentCsp('mainFrame', `http://127.0.0.1:${port + 1}/`, port)).toBeNull()
    expect(agentDocumentCsp('mainFrame', 'file:///etc/passwd', port)).toBeNull()
  })

  it('agent 未就绪（port 为 null）时不钉', () => {
    expect(agentDocumentCsp('mainFrame', `http://127.0.0.1:${port}/`, null)).toBeNull()
  })

  it('策略指令符合最小化基线', () => {
    // cordis ModuleLoader 的 __jsExpr 求值路径（new Function + eval）在发布产物中，
    // 且上游 webserver 会向主文档注入 inline bootstrap（__ModuleLoader__ facade
    // 与 __DSH_BOOT__ 全局），script-src 必须带 'unsafe-eval' 与 'unsafe-inline'，
    // 改动前需在 security.ts 注释中同步说明。
    expect(AGENT_CSP).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'")
    expect(AGENT_CSP).toContain("default-src 'self'")
    expect(AGENT_CSP).toContain("connect-src 'self'")
    expect(AGENT_CSP).toContain("object-src 'none'")
    expect(AGENT_CSP).toContain("base-uri 'none'")
    expect(AGENT_CSP).toContain("form-action 'none'")
    expect(AGENT_CSP).toContain("frame-ancestors 'none'")
  })
})
