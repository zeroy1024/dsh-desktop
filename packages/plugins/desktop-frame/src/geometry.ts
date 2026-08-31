/** 单行 titleband 高度（灯 + 折叠钮）。 */
export const TITLEBAND_HEIGHT = 44
/** macOS 红绿灯右侧空隙后的控件起点。 */
export const DARWIN_LEADING_PX = 92
/** 无原生灯时的控件起点。 */
export const FALLBACK_LEADING_PX = 12
/** 折叠态：灯区 + 两枚 24px 按钮与间隙（折叠、新会话）。 */
export const FOLDED_CLUSTER_PX = 172

export function titlebandLeadingPx(platform: string): number {
  return platform === 'darwin' ? DARWIN_LEADING_PX : FALLBACK_LEADING_PX
}

/** 顶带宽度：展开时跟侧栏，折叠时至少盖住灯行控件，blank 态铺满整窗但让出面板列。 */
export type TitlebandWidth = number | string

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
 * fullBleed 分支刻意不加 FOLDED_CLUSTER_PX 下限：面板全屏接管时让位结果
 * 可窄到侧栏轨道宽（折叠态 + 放大 = 约 56px），若再兜 172px 下限，多出的
 * 宽度是一条盖在面板 tab 条上的 drag 带，会吞掉 tab 点击——比"拖动带短
 * 一截"更糟。宽度内缩时折叠/新会话两钮只是溢出父盒（overflow 默认可见、
 * 各自 pointer-events:auto），绘制与点击都不受影响，属优雅降级。
 */
export function titlebandWidthPx(
  sidebarWidth: number,
  collapsed: boolean,
  platform: string,
  fullBleed: boolean,
  panelWidth = 0,
): TitlebandWidth {
  if (fullBleed) return panelWidth > 0 ? `calc(100% - ${panelWidth}px)` : '100%'
  const cluster = titlebandLeadingPx(platform) + 80
  if (collapsed) return Math.max(cluster, FOLDED_CLUSTER_PX)
  return Math.max(sidebarWidth, cluster)
}
