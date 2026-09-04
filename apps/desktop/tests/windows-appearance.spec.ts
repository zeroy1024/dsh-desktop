import { describe, expect, it } from 'vitest'
import {
  applyWindowsAppearance,
  createWindowsAppearanceController,
  resolveWindowsBackdrop,
  windowsBuildNumber,
  type AppearanceWindowLike,
  type NativeThemeLike,
  type WindowsAppearanceSnapshot,
} from '../src/main/windows-appearance'

describe('windowsBuildNumber', () => {
  it('解析 "10.0.22631" 这类系统版本字符串', () => {
    expect(windowsBuildNumber('10.0.22631')).toBe(22631)
    expect(windowsBuildNumber('6.3.9600')).toBe(9600)
  })

  it('解析无前导段或异常输入', () => {
    expect(windowsBuildNumber('22631')).toBe(22631)
    expect(windowsBuildNumber('not-a-version')).toBeNull()
    expect(windowsBuildNumber('')).toBeNull()
  })
})

describe('resolveWindowsBackdrop', () => {
  const normal = { dark: false, forcedColors: false, reducedTransparency: false }

  it('build >= 22000 且无无障碍偏好 → mica', () => {
    expect(resolveWindowsBackdrop('10.0.22631', normal)).toBe('mica')
    expect(resolveWindowsBackdrop('10.0.22000', normal)).toBe('mica')
  })

  it('Windows 10 及更早（< 22000）→ solid', () => {
    expect(resolveWindowsBackdrop('10.0.19045', normal)).toBe('solid')
    expect(resolveWindowsBackdrop('6.3.9600', normal)).toBe('solid')
  })

  it('build 不可知（非 Windows/异常输入）→ solid', () => {
    expect(resolveWindowsBackdrop('not-a-version', normal)).toBe('solid')
    expect(resolveWindowsBackdrop('', normal)).toBe('solid')
  })

  it('减少透明度或 forced colors → solid', () => {
    expect(resolveWindowsBackdrop('10.0.22631', { ...normal, reducedTransparency: true })).toBe('solid')
    expect(resolveWindowsBackdrop('10.0.22631', { ...normal, forcedColors: true })).toBe('solid')
    expect(resolveWindowsBackdrop('10.0.22631', { ...normal, forcedColors: true, reducedTransparency: true })).toBe('solid')
  })
})

function fakeWindow() {
  const calls: string[] = []
  const win: AppearanceWindowLike = {
    setBackgroundMaterial(material) {
      calls.push(`material:${material}`)
    },
    setBackgroundColor(color) {
      calls.push(`color:${color}`)
    },
    setTitleBarOverlay(options) {
      calls.push(`overlay:${options.color}:${String(options.height)}`)
    },
    isDestroyed() {
      return false
    },
  }
  return { win, calls }
}

function fakeTheme(overrides: Partial<NativeThemeLike> = {}) {
  const listeners = new Set<() => void>()
  return {
    themeSource: 'system' as 'system' | 'light' | 'dark',
    shouldUseDarkColors: false,
    inForcedColorsMode: false,
    prefersReducedTransparency: false,
    on(_event: 'updated', listener: () => void) {
      listeners.add(listener)
      return this
    },
    off(_event: 'updated', listener: () => void) {
      listeners.delete(listener)
      return this
    },
    emitUpdated() {
      for (const listener of listeners) listener()
    },
    ...overrides,
  }
}

describe('applyWindowsAppearance', () => {
  it('mica：材质 + 全透明底色（DWM 材质透出 WebContents 透明像素）', () => {
    const { win, calls } = fakeWindow()
    applyWindowsAppearance(win, { backdrop: 'mica', dark: true, forcedColors: false, reducedTransparency: false })
    expect(calls).toContain('material:mica')
    expect(calls).toContain('color:#00000000')
  })

  it('solid：材质 none + 深浅匹配的实底色', () => {
    const { win, calls } = fakeWindow()
    applyWindowsAppearance(win, { backdrop: 'solid', dark: false, forcedColors: false, reducedTransparency: true })
    expect(calls).toContain('material:none')
    expect(calls).toContain('color:#f6f7f9')
    applyWindowsAppearance(win, { backdrop: 'solid', dark: true, forcedColors: true, reducedTransparency: false })
    expect(calls).toContain('color:#1c1c1e')
  })

  it('每次都重新应用透明 WCO overlay（不硬编码 symbolColor，跟随 nativeTheme）', () => {
    const { win, calls } = fakeWindow()
    applyWindowsAppearance(win, { backdrop: 'mica', dark: false, forcedColors: false, reducedTransparency: false })
    applyWindowsAppearance(win, { backdrop: 'mica', dark: true, forcedColors: false, reducedTransparency: false })
    expect(calls.filter(call => call.startsWith('overlay:'))).toEqual(['overlay:#00000000:44', 'overlay:#00000000:44'])
  })
})

describe('createWindowsAppearanceController', () => {
  it('初始快照落窗并广播；nativeTheme.updated 重算；相同快照不重复广播', () => {
    const { win } = fakeWindow()
    const theme = fakeTheme({ shouldUseDarkColors: false })
    const snapshots: WindowsAppearanceSnapshot[] = []
    const controller = createWindowsAppearanceController(
      win,
      '10.0.22631',
      theme,
      snapshot => { snapshots.push(snapshot) },
    )
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ backdrop: 'mica', dark: false })
    expect(controller.snapshot().backdrop).toBe('mica')

    theme.shouldUseDarkColors = true
    theme.emitUpdated()
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]).toMatchObject({ dark: true })

    // 无实际变化：updated 也应在窗口上重应用但不广播
    theme.emitUpdated()
    expect(snapshots).toHaveLength(2)
  })

  it('无障碍状态进入时从 mica 回退 solid', () => {
    const { win } = fakeWindow()
    const theme = fakeTheme({ inForcedColorsMode: false })
    const controller = createWindowsAppearanceController(win, '10.0.22631', theme)
    expect(controller.snapshot().backdrop).toBe('mica')
    theme.inForcedColorsMode = true
    theme.emitUpdated()
    expect(controller.snapshot().backdrop).toBe('solid')
    expect(controller.snapshot().forcedColors).toBe(true)
  })

  it('Win10 build：初始即 solid；深浅切换只改底色不改材质', () => {
    const { win, calls } = fakeWindow()
    const theme = fakeTheme({ shouldUseDarkColors: false })
    const controller = createWindowsAppearanceController(win, '10.0.19045', theme)
    expect(controller.snapshot().backdrop).toBe('solid')
    expect(calls).toContain('material:none')
    theme.shouldUseDarkColors = true
    theme.emitUpdated()
    expect(calls.filter(call => call.startsWith('material:'))).toEqual(['material:none', 'material:none'])
    expect(calls).toContain('color:#1c1c1e')
  })

  it('setThemeSource 幂等写入 themeSource（触发 updated 重应用）', () => {
    const { win, calls } = fakeWindow()
    const theme = fakeTheme({ themeSource: 'system' })
    const controller = createWindowsAppearanceController(win, '10.0.22631', theme)
    controller.setThemeSource('dark')
    expect(theme.themeSource).toBe('dark')
    expect(calls.some(call => call.startsWith('material:'))).toBe(true)
    controller.setThemeSource('dark')
    expect(theme.themeSource).toBe('dark')
  })

  it('dispose 后 updated 不再重应用/广播（snapshot 本身仍是 live 读）', () => {
    const { win, calls } = fakeWindow()
    const theme = fakeTheme()
    const snapshots: WindowsAppearanceSnapshot[] = []
    const controller = createWindowsAppearanceController(
      win,
      '10.0.22631',
      theme,
      snapshot => { snapshots.push(snapshot) },
    )
    expect(snapshots).toHaveLength(1)
    controller.dispose()
    const callsBefore = calls.length
    theme.shouldUseDarkColors = true
    theme.emitUpdated()
    expect(calls).toHaveLength(callsBefore)
    expect(snapshots).toHaveLength(1)
  })
})