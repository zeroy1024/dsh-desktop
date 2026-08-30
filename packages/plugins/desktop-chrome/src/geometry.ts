/** 单行 titleband 高度（灯 + 折叠钮）。 */
export const TITLEBAND_HEIGHT = 44
/** macOS 红绿灯右侧空隙后的控件起点。 */
export const DARWIN_LEADING_PX = 92
/** 无原生灯时的控件起点。 */
export const FALLBACK_LEADING_PX = 12
/** 折叠态：灯区 + 两枚 24px 按钮与间隙。 */
export const FOLDED_CLUSTER_PX = 172

export function titlebandLeadingPx(platform: string): number {
  return platform === 'darwin' ? DARWIN_LEADING_PX : FALLBACK_LEADING_PX
}

/** 顶带宽度：展开时跟侧栏，折叠时至少盖住灯行控件，避免拖拽区伸进会话顶栏。 */
export function titlebandWidthPx(sidebarWidth: number, collapsed: boolean, platform: string): number {
  const cluster = titlebandLeadingPx(platform) + 80
  if (collapsed) return Math.max(cluster, FOLDED_CLUSTER_PX)
  return Math.max(sidebarWidth, cluster)
}
