import { describe, expect, it } from 'vitest'
import { RESTART_COOLDOWN_MS, RestartThrottle } from '../src/main/restart-throttle'

/**
 * 假时钟驱动：ever 变量即当前时刻，测试里拨表即可。RestartThrottle
 * 只依赖注入的 now()，不碰真实时间。
 */
function makeThrottle(nowRef: { now: number }): RestartThrottle {
  return new RestartThrottle(() => nowRef.now)
}

describe('RestartThrottle', () => {
  it('首次请求无条件放行（冷启动/CI 重启不被冷却卡住）', () => {
    const clock = { now: 1_000_000 }
    const throttle = makeThrottle(clock)
    expect(throttle.allowRestart()).toBe(true)
    expect(throttle.lastAcceptedAt()).toBe(1_000_000)
  })

  it('冷却窗内拒绝，窗口边界（>=RESTART_COOLDOWN_MS）放行', () => {
    const clock = { now: 0 }
    const throttle = makeThrottle(clock)
    expect(throttle.allowRestart()).toBe(true)
    clock.now += RESTART_COOLDOWN_MS - 1
    expect(throttle.allowRestart()).toBe(false)
    clock.now += 1
    expect(throttle.allowRestart()).toBe(true)
  })

  it('被拒请求不推进冷却窗：拒绝后间隔只按上次接受时刻算', () => {
    const clock = { now: 0 }
    const throttle = makeThrottle(clock)
    throttle.allowRestart()
    clock.now += 1_000
    expect(throttle.allowRestart()).toBe(false)
    clock.now += 2_000 // 距上次接受共 3s；期间那次拒绝不该把窗口顺延
    expect(throttle.allowRestart()).toBe(true)
  })

  it('连续点击风暴只放行第一个，后续全部拒绝且不提前开窗', () => {
    const clock = { now: 0 }
    const throttle = makeThrottle(clock)
    expect(throttle.allowRestart()).toBe(true)
    for (let i = 0; i < 100; i += 1) {
      clock.now += 10 // 风暴推进 1000ms（远小于冷却）
      expect(throttle.allowRestart()).toBe(false)
    }
    clock.now += RESTART_COOLDOWN_MS - 1_001 // 距接受共 2999ms，仍不足 3s（拒绝未推窗）
    expect(throttle.allowRestart()).toBe(false)
    clock.now += 1
    expect(throttle.allowRestart()).toBe(true)
  })

  it('放行后重新计时：连续两次放行之间必须满冷却', () => {
    const clock = { now: 0 }
    const throttle = makeThrottle(clock)
    expect(throttle.allowRestart()).toBe(true)
    clock.now += 3_000
    expect(throttle.allowRestart()).toBe(true)
    clock.now += 1_000
    expect(throttle.allowRestart()).toBe(false)
  })
})