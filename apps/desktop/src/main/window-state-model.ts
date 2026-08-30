export interface RectangleLike {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800 }
const MIN_WIDTH = 800
const MIN_HEIGHT = 600
const MIN_VISIBLE_AREA = 64 * 64

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function visibleArea(bounds: RectangleLike, workArea: RectangleLike): number {
  const width = Math.max(
    0,
    Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x),
  )
  const height = Math.max(
    0,
    Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y),
  )
  return width * height
}

/** 校验持久化边界；拔掉外接屏后把离屏窗口拉回主显示器。 */
export function normalizeWindowState(
  input: Partial<WindowState>,
  workAreas: readonly RectangleLike[],
  primary: RectangleLike,
): WindowState {
  const requestedWidth = finite(input.width) && input.width > 0 ? input.width : DEFAULT_STATE.width
  const requestedHeight = finite(input.height) && input.height > 0 ? input.height : DEFAULT_STATE.height
  const hasPosition = finite(input.x) && finite(input.y)
  const rawBounds = hasPosition
    ? { x: input.x!, y: input.y!, width: requestedWidth, height: requestedHeight }
    : null
  const target = rawBounds === null
    ? { area: primary, visible: 0 }
    : workAreas.reduce<{ area: RectangleLike; visible: number }>(
        (best, area) => {
          const visible = visibleArea(rawBounds, area)
          return visible > best.visible ? { area, visible } : best
        },
        { area: primary, visible: visibleArea(rawBounds, primary) },
      )
  const workArea = target.visible >= MIN_VISIBLE_AREA ? target.area : primary
  const maxWidth = Math.max(1, workArea.width)
  const maxHeight = Math.max(1, workArea.height)
  const width = Math.round(clamp(requestedWidth, Math.min(MIN_WIDTH, maxWidth), maxWidth))
  const height = Math.round(clamp(requestedHeight, Math.min(MIN_HEIGHT, maxHeight), maxHeight))
  const position = rawBounds !== null && target.visible >= MIN_VISIBLE_AREA
    ? {
        x: Math.round(clamp(rawBounds.x, workArea.x - width + 64, workArea.x + workArea.width - 64)),
        y: Math.round(clamp(rawBounds.y, workArea.y - height + 64, workArea.y + workArea.height - 64)),
      }
    : {
        x: primary.x + Math.round((primary.width - width) / 2),
        y: primary.y + Math.round((primary.height - height) / 2),
      }
  return {
    width,
    height,
    ...position,
    ...(typeof input.isMaximized === 'boolean' ? { isMaximized: input.isMaximized } : {}),
  }
}
