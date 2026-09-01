/**
 * 角落徽章：P2 通道验收用，用户能在主界面右下角看到 "hello-panel"。
 * overlay 层默认 pointer-events: none，子节点自动恢复可点。
 */
export function HelloBadge() {
  return (
    <div
      data-dsh-hello-panel=""
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 30,
        padding: '6px 10px',
        borderRadius: 'var(--dsh-radius-control, 8px)',
        background: 'rgba(16, 18, 26, 0.78)',
        color: '#fff',
        fontSize: 12,
        lineHeight: '16px',
        letterSpacing: '0.02em',
        userSelect: 'none',
      }}
    >
      hello-panel
    </div>
  )
}
