import { describe, expect, it } from 'vitest'
import { isPermissionAllowed } from '../src/main/permissions'

describe('isPermissionAllowed', () => {
  const port = 41234

  it('放行 agent origin 的剪贴板净化写入（含带路径/查询串的 URL）', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', `http://127.0.0.1:${port}`, port)).toBe(true)
    expect(isPermissionAllowed('clipboard-sanitized-write', `http://127.0.0.1:${port}/chat?session=1`, port)).toBe(true)
  })

  it('拒绝白名单之外的权限', () => {
    expect(isPermissionAllowed('clipboard-read', `http://127.0.0.1:${port}`, port)).toBe(false)
    expect(isPermissionAllowed('geolocation', `http://127.0.0.1:${port}`, port)).toBe(false)
    expect(isPermissionAllowed('notifications', `http://127.0.0.1:${port}`, port)).toBe(false)
    expect(isPermissionAllowed('media', `http://127.0.0.1:${port}`, port)).toBe(false)
  })

  it('拒绝非 agent 来源', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', 'https://evil.example', port)).toBe(false)
    expect(isPermissionAllowed('clipboard-sanitized-write', `http://127.0.0.1:${port + 1}`, port)).toBe(false)
    expect(isPermissionAllowed('clipboard-sanitized-write', 'file:///etc/passwd', port)).toBe(false)
    expect(isPermissionAllowed('clipboard-sanitized-write', `http://user:pass@127.0.0.1:${port}`, port)).toBe(false)
  })

  it('agent 未就绪（port 为 null）时全拒', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', `http://127.0.0.1:${port}`, null)).toBe(false)
  })

  it('origin 缺失或无法解析时全拒', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', undefined, port)).toBe(false)
    expect(isPermissionAllowed('clipboard-sanitized-write', 'not-a-url', port)).toBe(false)
  })
})
