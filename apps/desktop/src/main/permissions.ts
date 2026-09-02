/**
 * permissions.ts — 渲染进程权限放行判定（纯函数，便于单测）。
 */

import { isAgentRendererUrl } from '@dsh-desktop/bridge'

/**
 * 渲染进程可持有的权限白名单：剪贴板净化写入是 WebUI 复制按钮的基础能力，
 * 只允许写入净化后的纯文本、没有任何读取能力（读取是另一个权限
 * clipboard-read，涉及密码等敏感内容，继续拒绝）；geolocation、通知、
 * media 等其余权限一律不在名单内。
 */
const allowedPermissions: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/**
 * 判定一次权限请求/检查是否放行：按权限名白名单，且请求来源必须是当前
 * 这一代 agent 的 origin。port 为 null（agent 未就绪）或来源无法解析时
 * 一律拒绝，保持“默认全拒”的安全基线。
 */
export function isPermissionAllowed(
  permission: string,
  origin: string | undefined,
  port: number | null,
): boolean {
  if (!allowedPermissions.has(permission) || port === null || origin === undefined) return false
  return isAgentRendererUrl(origin, port)
}
