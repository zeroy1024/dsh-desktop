import { describe, expect, it } from 'vitest'
import { parseReadyLine } from '../src/ready-line'

describe('parseReadyLine', () => {
  it('解析标准 ready 行', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:4567/?token=test-token')).toEqual({
      url: 'http://127.0.0.1:4567/?token=test-token',
      port: 4567,
      token: 'test-token',
    })
  })

  it('解析带 LAN 后缀的 ready 行，取本机 URL', () => {
    const line = 'dsh web: http://127.0.0.1:4567/?token=t (LAN: http://192.168.1.5:4567/?token=t)'
    expect(parseReadyLine(line)).toEqual({
      url: 'http://127.0.0.1:4567/?token=t',
      port: 4567,
      token: 't',
    })
  })

  it('显式端口缺省时按协议取默认端口', () => {
    expect(parseReadyLine('dsh web: http://localhost/?token=abc')?.port).toBe(80)
  })

  it('拒绝噪声行', () => {
    expect(parseReadyLine('booting plugins...')).toBeNull()
    expect(parseReadyLine('dsh web: opening the default browser; pass --no-open to disable')).toBeNull()
    expect(parseReadyLine('')).toBeNull()
  })

  it('解析无 token 的 ready 行（上游 0.1.1-rc.2），token 为 null', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:64819')).toEqual({
      url: 'http://127.0.0.1:64819',
      port: 64819,
      token: null,
    })
  })

  it('正则命中但 URL 无法解析时返回 null', () => {
    // 形如 ready 行但 new URL 抛错（空主机），按非 ready 行处理
    expect(parseReadyLine('dsh web: http://:80')).toBeNull()
  })
})
