/**
 * splash.ts — 启动层渲染脚本（file:// 本地页，esbuild 打为 IIFE）。
 *
 * 主进程经 preload 桥（window.dshSplash）推送启动进度与阶段，本脚本驱动
 * 水位动画与相位 class；视图摘除由主进程负责，本脚本不碰视图生命周期。
 * 水位语义与 Tauri 参照实现一致：真实进度为下限，时间兜底曲线保证静默期
 * 水面仍在缓慢上涨，两者取较大值，单调不回退。
 */

export type SplashPhase = 'starting' | 'loading' | 'sealed' | 'revealed' | 'error'

declare global {
  interface Window {
    dshSplash?: {
      platform: string
      onProgress: (listener: (percent: number) => void) => () => void
      onPhase: (listener: (phase: SplashPhase, message?: string) => void) => () => void
    }
  }
}

/** 水位初始值：完全处于鲸鱼剪影之下（viewBox 单位）。 */
const WATER_HIDDEN = 50
/** 鲸鱼下缘（viewBox 单位）：水位 0% 时水面恰好触及、开始可见。 */
const WATER_VISIBLE_BOTTOM = 44
/** 定格推满的缓动。 */
const SEAL_EASE = 'cubic-bezier(0.7, 0, 0.3, 1)'
/** 渐进上涨的缓动：每拍平滑趋近目标。 */
const CREEP_EASE = 'cubic-bezier(0.33, 0, 0.67, 1)'
const CREEP_INTERVAL_MS = 800
/** 时间兜底曲线时间常数：75·(1−e^(−t/25))，快速起步、随真实进度超越后让位。 */
const CREEP_TIME_CONSTANT_S = 25
const REDUCED_MOTION_SCALE = 0.3

const PHASE_CLASSES: Readonly<Record<SplashPhase, string>> = {
  starting: 'phase-starting',
  loading: 'phase-loading',
  sealed: 'phase-sealed',
  revealed: 'phase-revealed',
  error: 'phase-error',
}

const REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const splash = document.querySelector<HTMLElement>('#splash')
const errorMessage = document.querySelector<HTMLElement>('#error-message')
const inkLevel = splash?.querySelector<SVGGElement>('.ink-level') ?? null
const whaleBob = splash?.querySelector<HTMLElement>('.whale-bob') ?? null

// 平台写入 dataset：CSS 据此为非 darwin 平台回落不透明白底
document.documentElement.dataset.dshPlatform = window.dshSplash?.platform ?? ''

let realPercent = 0
let creepTimer: number | undefined
let creepStartedAt = 0

function setWaterLevel(units: number, durationSec: number, easing: string): void {
  if (inkLevel === null) return
  const duration = REDUCED_MOTION ? Math.max(0.2, durationSec * REDUCED_MOTION_SCALE) : durationSec
  inkLevel.style.transition = `transform ${duration}s ${easing}`
  inkLevel.style.transform = `translateY(${units}px)`
}

/** 启动百分比（0-100）映射到水位：0% 触及鲸鱼下缘，100% 推满到剪影顶。 */
function percentToLevel(percent: number): number {
  return WATER_VISIBLE_BOTTOM - WATER_VISIBLE_BOTTOM * (percent / 100)
}

function startProgressCreep(): void {
  stopProgressCreep()
  creepStartedAt = Date.now()
  creepTimer = window.setInterval(() => {
    const elapsedS = (Date.now() - creepStartedAt) / 1000
    const timePercent = 75 * (1 - Math.exp(-elapsedS / CREEP_TIME_CONSTANT_S))
    const target = Math.min(96, Math.max(timePercent, realPercent))
    setWaterLevel(percentToLevel(target), 1.4, CREEP_EASE)
  }, CREEP_INTERVAL_MS)
}

function stopProgressCreep(): void {
  if (creepTimer !== undefined) {
    window.clearInterval(creepTimer)
    creepTimer = undefined
  }
}

/**
 * 定格前把呼吸动画的当前位移接住，再缓回 translateY(0)。
 * 直接摘掉 `bob` 动画会从最高 2px 处瞬间归零，看起来像图标往上跳。
 */
function settleBob(): void {
  if (whaleBob === null) return
  const computed = getComputedStyle(whaleBob).transform
  whaleBob.style.animation = 'none'
  whaleBob.style.transform = computed === 'none' ? 'translateY(0px)' : computed
  void whaleBob.getBoundingClientRect()
  const duration = REDUCED_MOTION ? 0.1 : 0.35
  whaleBob.style.transition = `transform ${duration}s ease`
  whaleBob.style.transform = 'translateY(0px)'
}

function resetBob(): void {
  if (whaleBob === null) return
  whaleBob.style.animation = ''
  whaleBob.style.transition = ''
  whaleBob.style.transform = ''
}

function applyPhase(phase: SplashPhase, message?: string): void {
  if (splash === null) return
  // 切走 loading 之前先冻结呼吸位移，否则 class 一换动画被掐、图标会跳
  if (phase === 'sealed' || phase === 'error') settleBob()
  if (phase === 'starting') resetBob()

  for (const name of Object.values(PHASE_CLASSES)) splash.classList.remove(name)
  splash.classList.add(PHASE_CLASSES[phase])

  if (phase === 'starting') {
    // 每次启动都是全新视觉尝试，不带入上一轮的水位与错误文案
    realPercent = 0
    if (errorMessage !== null) errorMessage.textContent = ''
    startProgressCreep()
  }
  if (phase === 'sealed') {
    stopProgressCreep()
    setWaterLevel(0, 1.2, SEAL_EASE)
  }
  if (phase === 'error') {
    stopProgressCreep()
    setWaterLevel(WATER_HIDDEN, 0.6, CREEP_EASE)
    if (message !== undefined && errorMessage !== null) errorMessage.textContent = message
  }
  // revealed：class 驱动的淡出由 CSS 完成；摘除视图是主进程的事
}

window.dshSplash?.onProgress((percent) => {
  realPercent = percent
})
window.dshSplash?.onPhase((phase, message) => {
  applyPhase(phase, message)
})
