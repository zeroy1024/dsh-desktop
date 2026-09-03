/**
 * 复制兜底（client 半）：宿主 writeClipboard 走 async Clipboard API，被权限
 * check 拒绝或文档失焦时返回 false——此时回退到同步 execCommand('copy')
 * （deprecated 但仍是点击手势内最可靠的兜底路径）。两路都失败才算失败，
 * 调用方负责给出可见的成功/失败反馈。
 */

/** 宿主 writeClipboard 的结构镜像（运行时经 loader 模块表提供同一实例）。 */
type HostWriteClipboard = (text: string) => Promise<boolean>

/** 宿主实例的惰性取值（缺省时直接走兜底）。 */
let hostWrite: HostWriteClipboard | undefined

/** 注入宿主 writeClipboard（index.ts 注册期调用一次）。 */
export function setHostWriteClipboard(fn: HostWriteClipboard): void {
  hostWrite = fn
}

/** 同步 execCommand 兜底复制。 */
function execCommandCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
}

/**
 * 复制文本：宿主 async API → execCommand 兜底，两路都失败才返回 false。
 * @param text - 要放入剪贴板的文本。
 * @returns 最终是否写入成功。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (hostWrite !== undefined && await hostWrite(text)) return true
  } catch {
    // 宿主失败（权限/失焦）→ 落到兜底。
  }
  return execCommandCopy(text)
}
