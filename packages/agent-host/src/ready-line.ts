/**
 * ready-line.ts — 解析 `dsh web` 启动完成时打印的 ready 行。
 *
 * 上游格式（upstream/packages/bundle/web-app/src/index.ts）：
 *   dsh web: http://127.0.0.1:3080/?token=<token>
 *   dsh web: http://127.0.0.1:3080/?token=<token> (LAN: http://192.168.x.x:3080/?token=<token>)
 */

/** 一条成功解析的 ready 行携带的信息。 */
export interface ReadyLineInfo {
  /** ready 行携带的完整 URL，可直接交给 BrowserWindow.loadURL。 */
  url: string
  /** 实际监听端口（`--port 0` 时由 OS 分配，以此为准）。 */
  port: number
  /** 启动 token（浏览器用它换取签名 cookie）；上游 0.1.1-rc.2 起部分版本无 token，为 null。 */
  token: string | null
}

const READY_PATTERN = /^dsh web: (https?:\/\/\S+?)(?:\s+\(LAN: .+\))?$/

/**
 * 解析一行 stdout 输出；不是 ready 行时返回 null。
 *
 * @param line - 单行 stdout 文本（可带行尾空白）。
 * @returns 解析结果，非 ready 行返回 null。
 */
export function parseReadyLine(line: string): ReadyLineInfo | null {
  const match = READY_PATTERN.exec(line.trim())
  if (!match) return null
  let parsed: URL
  try {
    parsed = new URL(match[1])
  } catch {
    return null
  }
  const token = parsed.searchParams.get('token')
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  return { url: match[1], port, token }
}
