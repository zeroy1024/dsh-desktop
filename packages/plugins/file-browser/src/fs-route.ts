/**
 * file-browser 路由前缀与 raw 图片 URL 构造（node 半与 client 半共享的纯
 * 常量/纯函数模块：零 Node API、零 DOM API，两半都可打包）。
 *
 * 单独成文件的理由：前缀字符串是两侧的共同事实——node 半用它注册 prefix
 * 路由，client 半用它拼 `<img src>`；此前前缀只存在于 fs-handler.ts，
 * client 半若要引用就必须 import node 半（拉进 node:fs），违反打包边界。
 */

/** 数据面路由前缀（list/read/raw 三 op 共享）。 */
export const FS_ROUTE_PREFIX = '/dsh-file-browser'

/** raw 图片的供给通道：会话 root 相对（path 参数）或文件系统绝对（abs 参数）。 */
export type RawImageChannel = 'workspace' | 'external-file'

/**
 * 构造 raw 路由的图片 URL（同源相对路径；渲染进程的 origin 即当前 agent）。
 * @param sessionId - 会话 id（服务端据此解析 root，客户端不传 root）。
 * @param src - workspace 通道 = root 相对 POSIX 路径；external-file 通道 = 规范化绝对路径。
 * @param channel - 供给通道，决定 path/abs 参数名。
 */
export function rawImageUrl(sessionId: string, src: string, channel: RawImageChannel): string {
  const params = new URLSearchParams({ sessionId })
  params.set(channel === 'workspace' ? 'path' : 'abs', src)
  return `${FS_ROUTE_PREFIX}/raw?${params.toString()}`
}
