/**
 * geometry.ts — 单行 titleband 几何纯函数。
 *
 * 单一事实源：Titleband 用 ResizeObserver 测量左簇（菜单栏/折叠钮/新会话）
 * 真实右缘，同时写入 `--dsh-titleband-content-end`（CSS 变量，折叠态 header
 * padding 与分隔线位置从它推导）——TS 与 CSS 不再各自维护 172/168/159.5
 * 三份 darwin 常量，Windows/Linux 也不再落入约 100px 假灯区。
 */

/** 单行 titleband 高度（灯 + 折叠钮）。 */
export const TITLEBAND_HEIGHT = 44
/** macOS 红绿灯右侧空隙后的控件起点。 */
export const DARWIN_LEADING_PX = 92
/** 无原生灯时的控件起点。 */
export const FALLBACK_LEADING_PX = 12

/** 测量缺失时的保守左簇宽：起点 + 两枚 24px 按钮 + 8px 间隙 + 光学余量。 */
export const FALLBACK_CLUSTER_PX = 80

export function titlebandLeadingPx(platform: string): number {
  return platform === 'darwin' ? DARWIN_LEADING_PX : FALLBACK_LEADING_PX
}

/** 顶带宽度：展开时跟侧栏，折叠时至少盖住灯行控件，blank 态铺满整窗但让出面板列。 */
export type TitlebandWidth = number | string

/**
 * 左簇宽度：优先真实测量（含菜单栏）；未测量时按平台回落
 * （darwin 红绿灯 92px 或 12px 起点 + 按钮簇）。
 */
export function clusterWidthPx(contentEnd: number, platform: string): number {
  return contentEnd > 0 ? contentEnd : titlebandLeadingPx(platform) + FALLBACK_CLUSTER_PX
}

/**
 * 全宽判定：仅当中栏列已被 markDesktopFrame 标记（皮肤生效）且 header 不可见
 * （blank 态 display:none，rect 高度为 0）时铺满。标记缺失时必须保持侧栏宽
 * 保守降级——否则全宽 drag 层会吞掉官方 header 的点击，而此时我们的
 * no-drag 挖洞规则（选择器同样依赖标记）也未生效。
 */
export function shouldStretchTitleband(centerColMarked: boolean, headerHeight: number): boolean {
  return centerColMarked && headerHeight <= 0
}

/**
 * 顶带宽度：fullBleed 时铺满整窗，但让出面板列（panelWidth > 0 时返回
 * calc 表达式）——面板 header（tab 条、×、+）位于顶部 44px 带内，被全宽
 * drag 层盖住则真实点击会被窗口拖动手势吞掉。panelWidth 是观察到的面板列
 * 渲染宽，让位收缩/全屏接管/拖拽后的终值天然正确；面板关（宽 0）时退回
 * 纯 100%（现状）。极端窄视口下让位链会自动关闭面板（panelWidth 归零），
 * 拖动带随之恢复全宽。
 *
 * 非 fullBleed（会话态）展开时跟侧栏宽、折叠时盖住左簇；contentEnd 是
 * 测量的真实左簇右缘，Windows/Linux 不再落入 darwin 假灯区。
 */
export function titlebandWidthPx(
  sidebarWidth: number,
  collapsed: boolean,
  platform: string,
  fullBleed: boolean,
  panelWidth = 0,
  contentEnd = 0,
): TitlebandWidth {
  if (fullBleed) return panelWidth > 0 ? `calc(100% - ${panelWidth}px)` : '100%'
  const cluster = clusterWidthPx(contentEnd, platform)
  if (collapsed) return cluster
  return Math.max(sidebarWidth, cluster)
}