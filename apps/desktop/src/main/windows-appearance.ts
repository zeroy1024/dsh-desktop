/**
 * windows-appearance.ts — Windows 窗口外观控制器（仅 win32 装配）。
 *
 * - Mica：只在 Windows 11（build >= 22000）且系统没有关闭透明度、没有
 *   强制颜色（高对比度）时启用；其余情况明确回退 solid 实底，避免透明
 *   backdrop 下出现无底色的窗口。
 * - 深浅：跟随 nativeTheme（themeSource 由渲染进程按 WebUI 主题偏好驱动），
 *   solid 底色按当前深浅选择安全色；Mica 模式下窗口底色保持透明，材质由
 *   DWM 绘制在 WebContents 之下。
 * - 系统版本判定用 process.getSystemVersion() 的 build 号，不能把
 *   setBackgroundMaterial('mica') 的调用成功误当作系统支持。
 * - 事件源是 nativeTheme.updated：深浅、强制颜色、减少透明度变化都会命中。
 */
import { nativeTheme, type BrowserWindow } from 'electron'

export type WindowsBackdrop = 'mica' | 'solid'

/** 不可变外观快照：渲染进程只读消费，CSS 按 dataset 切换材质/回退。 */
export interface WindowsAppearanceSnapshot {
  /** Mica 或明确实底回退。 */
  backdrop: WindowsBackdrop
  /** 当前生效深浅（solid 底色选择用；页面自身的深浅由 ui-theme 负责）。 */
  dark: boolean
  /** Windows 高对比度（forced colors）激活。 */
  forcedColors: boolean
  /** 系统「减少透明度」偏好激活。 */
  reducedTransparency: boolean
}

export interface AppearanceInputs {
  dark: boolean
  forcedColors: boolean
  reducedTransparency: boolean
}

/** 从 "10.0.22631" 这类系统版本字符串解析 build 号；无法解析返回 null。 */
export function windowsBuildNumber(systemVersion: string): number | null {
  const match = /^(\d+\.\d+\.)?(\d+)$/.exec(systemVersion.trim())
  if (match === null) return null
  const build = Number(match[2])
  return Number.isSafeInteger(build) ? build : null
}

/**
 * 判定窗口 backdrop：
 * - build 不可知（非 Windows）或 < 22000（Windows 10 及更早）→ solid；
 * - 系统关闭透明度或处于强制颜色模式 → solid（材质不可用/必须保证对比）；
 * - 其余 → mica。
 */
export function resolveWindowsBackdrop(systemVersion: string, inputs: AppearanceInputs): WindowsBackdrop {
  const build = windowsBuildNumber(systemVersion)
  if (build === null || build < 22000) return 'solid'
  if (inputs.forcedColors || inputs.reducedTransparency) return 'solid'
  return 'mica'
}

/** 主进程对窗口可施加的外观操作（BrowserWindow 的真实子集）。 */
export interface AppearanceWindowLike {
  setBackgroundMaterial(material: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed'): void
  setBackgroundColor(color: string): void
  setTitleBarOverlay(options: { color?: string; symbolColor?: string; height?: number }): void
  isDestroyed(): boolean
  /**
   * 窗口已实际关闭（closed 事件）后返回 true；控制器据此跳过已脱离
   * 生命周期的对象。测试 fake 直接返回 false。
   */
}

/** 把快照落到窗口：Mica 透明底 / solid 实底色 + 透明 WCO 覆盖层。 */
export function applyWindowsAppearance(win: AppearanceWindowLike, snapshot: WindowsAppearanceSnapshot): void {
  if (snapshot.backdrop === 'mica') {
    win.setBackgroundMaterial('mica')
    // 材质要透出 WebContents 的透明像素，窗口底色必须全透明（官方配方）。
    win.setBackgroundColor('#00000000')
  } else {
    win.setBackgroundMaterial('none')
    // solid：与当前深浅匹配的侧栏底色，避免「透明窗口 + 无 backdrop」。
    win.setBackgroundColor(snapshot.dark ? '#1c1c1e' : '#f6f7f9')
  }
  // 透明 WCO 覆盖层固定 44px，不硬编码 symbolColor，让 Electron 按当前
  // nativeTheme 选择系统对比色；每次更新都重新应用以跟随主题变化。
  win.setTitleBarOverlay({ color: '#00000000', height: 44 })
}

/** nativeTheme 的测试面（真实对象是 electron.nativeTheme）。 */
export interface NativeThemeLike {
  themeSource: 'system' | 'light' | 'dark'
  shouldUseDarkColors: boolean
  inForcedColorsMode: boolean
  prefersReducedTransparency: boolean
  on(event: 'updated', listener: () => void): unknown
  off(event: 'updated', listener: () => void): unknown
}

export function isNativeThemeSource(value: unknown): value is 'system' | 'light' | 'dark' {
  return value === 'system' || value === 'light' || value === 'dark'
}

export interface WindowsAppearanceController {
  /** 当前外观快照（每次新对象；IPC 序列化安全）。 */
  snapshot: () => WindowsAppearanceSnapshot
  /**
   * 设置 nativeTheme.themeSource。'system' 之外的值会把 Chromium 的
   * prefers-color-scheme 一并覆盖，因此必须与 WebUI 主题偏好保持一致。
   */
  setThemeSource: (source: 'system' | 'light' | 'dark') => void
  /** 注销 nativeTheme 监听；窗口 closed 时调用。 */
  dispose: () => void
}

/**
 * 创建 Windows 外观控制器：初始应用一次快照，此后 nativeTheme.updated
 * 时重算并应用；快照实际变化时才回调 onSnapshot（广播给渲染进程）。
 */
export function createWindowsAppearanceController(
  win: AppearanceWindowLike,
  systemVersion: string,
  theme: NativeThemeLike,
  onSnapshot?: (snapshot: WindowsAppearanceSnapshot) => void,
): WindowsAppearanceController {
  let last: WindowsAppearanceSnapshot | null = null

  const read = (): WindowsAppearanceSnapshot => ({
    backdrop: resolveWindowsBackdrop(systemVersion, {
      dark: theme.shouldUseDarkColors,
      forcedColors: theme.inForcedColorsMode,
      reducedTransparency: theme.prefersReducedTransparency,
    }),
    dark: theme.shouldUseDarkColors,
    forcedColors: theme.inForcedColorsMode,
    reducedTransparency: theme.prefersReducedTransparency,
  })

  const sync = (): void => {
    if (win.isDestroyed()) return
    const snapshot = read()
    applyWindowsAppearance(win, snapshot)
    if (last !== null
      && snapshot.backdrop === last.backdrop
      && snapshot.dark === last.dark
      && snapshot.forcedColors === last.forcedColors
      && snapshot.reducedTransparency === last.reducedTransparency) {
      return
    }
    last = snapshot
    onSnapshot?.(snapshot)
  }

  theme.on('updated', sync)
  sync()
  return {
    snapshot: read,
    setThemeSource(source) {
      if (theme.themeSource === source) return
      // 写入会触发 nativeTheme.updated → sync() 重新应用并广播。
      theme.themeSource = source
    },
    dispose() {
      theme.off('updated', sync)
    },
  }
}

/** 真实装配入口：按当前平台与系统构造控制器（非 win32 返回 null）。 */
export function createWindowsAppearance(win: BrowserWindow): WindowsAppearanceController | null {
  if (process.platform !== 'win32') return null
  return createWindowsAppearanceController(win, process.getSystemVersion(), nativeTheme)
}