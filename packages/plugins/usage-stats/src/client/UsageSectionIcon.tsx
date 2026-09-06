/**
 * 「用量统计」导航图标：自绘柱状图（不 import ui-primitives，避免测试 stub）。
 * Settings 壳提供几何（className/size），颜色跟随 currentColor。
 */
export function UsageSectionIcon({ className, size }: { className?: string; size: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3.5" y="10" width="3" height="6.5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="8.5" y="6" width="3" height="10.5" rx="1" fill="currentColor" opacity="0.8" />
      <rect x="13.5" y="3" width="3" height="13.5" rx="1" fill="currentColor" />
    </svg>
  )
}
