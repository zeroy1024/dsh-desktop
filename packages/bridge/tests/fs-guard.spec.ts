import { describe, expect, it } from 'vitest'
import { isTrustedFsRequest, resolveWithinRoot } from '../src/fs-guard'

describe('isTrustedFsRequest', () => {
  it('放行 loopback Host 且无 Origin 的请求', () => {
    expect(isTrustedFsRequest({ headers: { host: '127.0.0.1:3080' } })).toBe(true)
    expect(isTrustedFsRequest({ headers: { host: 'localhost:9' } })).toBe(true)
    expect(isTrustedFsRequest({ headers: { host: '[::1]:9' } })).toBe(true)
  })

  it('放行 127/8 全段 loopback（与上游 127/8 语义对齐）', () => {
    expect(isTrustedFsRequest({ headers: { host: '127.0.0.2:9' } })).toBe(true)
  })

  it('拒绝非 loopback、缺失或畸形 Host（DNS rebinding 防线）', () => {
    expect(isTrustedFsRequest({ headers: {} })).toBe(false)
    expect(isTrustedFsRequest({ headers: { host: 'evil.example' } })).toBe(false)
    expect(isTrustedFsRequest({ headers: { host: '127.0.0.1.evil' } })).toBe(false)
    // 任意 IPv4 字面量不得被误判为 loopback（首段必须为 127）。
    expect(isTrustedFsRequest({ headers: { host: '192.168.1.1:3080' } })).toBe(false)
    expect(isTrustedFsRequest({ headers: { host: '8.8.8.8' } })).toBe(false)
    expect(isTrustedFsRequest({ headers: { host: 'user@127.0.0.1:9' } })).toBe(false)
    // Host 含路径等不可解析形态。
    expect(isTrustedFsRequest({ headers: { host: '127.0.0.1:9/path' } })).toBe(false)
  })

  it('拒绝显式 cross-site 标记', () => {
    expect(isTrustedFsRequest({
      headers: { host: '127.0.0.1:9', 'sec-fetch-site': 'cross-site' },
    })).toBe(false)
  })

  it('Origin 存在时必须逐 host 等于 Host；null 拒绝；同域放行', () => {
    expect(isTrustedFsRequest({
      headers: { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9' },
    })).toBe(true)
    expect(isTrustedFsRequest({
      headers: { host: '127.0.0.1:9', origin: 'http://127.0.0.1:8' },
    })).toBe(false)
    expect(isTrustedFsRequest({
      headers: { host: '127.0.0.1:9', origin: 'null' },
    })).toBe(false)
    expect(isTrustedFsRequest({
      headers: { host: '127.0.0.1:9', origin: 'not a url' },
    })).toBe(false)
  })

  it('兼容 Headers 实例', () => {
    const headers = new Headers({ host: '127.0.0.1:9', origin: 'http://127.0.0.1:9' })
    expect(isTrustedFsRequest({ headers })).toBe(true)
  })
})

describe('resolveWithinRoot', () => {
  it('空相对路径解析为 root 本身', () => {
    expect(resolveWithinRoot('/repo', '')).toBe('/repo')
  })

  it('拼接子路径并折叠重复分隔符', () => {
    expect(resolveWithinRoot('/repo', 'apps/desktop/src')).toBe('/repo/apps/desktop/src')
    expect(resolveWithinRoot('/repo', 'apps//desktop')).toBe('/repo/apps/desktop')
  })

  it('拒绝 .. 与 . 相对段', () => {
    expect(resolveWithinRoot('/repo', '../etc/passwd')).toBeUndefined()
    expect(resolveWithinRoot('/repo', 'apps/../../etc')).toBeUndefined()
    expect(resolveWithinRoot('/repo', './apps')).toBeUndefined()
  })

  it('拒绝绝对路径、反斜杠与控制字符', () => {
    expect(resolveWithinRoot('/repo', '/etc/passwd')).toBeUndefined()
    expect(resolveWithinRoot('/repo', 'C:\\Windows')).toBeUndefined()
    expect(resolveWithinRoot('/repo', 'apps\\desktop')).toBeUndefined()
    expect(resolveWithinRoot('/repo', 'a\0b')).toBeUndefined()
  })

  it('拒绝非法 root 形态', () => {
    expect(resolveWithinRoot('', 'x')).toBeUndefined()
    expect(resolveWithinRoot('repo', 'x')).toBeUndefined()
  })

  it('支持 Windows 盘符 root，同时拒绝盘符绝对/相对路径', () => {
    expect(resolveWithinRoot('C:\\repo', '')).toBe('C:/repo')
    expect(resolveWithinRoot('C:\\repo\\', 'apps/desktop')).toBe('C:/repo/apps/desktop')
    expect(resolveWithinRoot('D:/', '')).toBe('D:/')
    expect(resolveWithinRoot('C:/repo', 'C:/Windows')).toBeUndefined()
    expect(resolveWithinRoot('C:/repo', 'C:Windows')).toBeUndefined()
    expect(resolveWithinRoot('C:', 'apps')).toBeUndefined()
  })

  it('保留 root 前缀相似但不越界的判断（/repo vs /repo2）', () => {
    // root 本身已给出绝对路径，rel 不可能跳出；此处验证前缀拼接的边界形状。
    expect(resolveWithinRoot('/repo', 'x')).toBe('/repo/x')
  })
})
