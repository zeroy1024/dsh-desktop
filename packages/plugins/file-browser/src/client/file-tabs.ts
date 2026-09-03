/**
 * 页面内的「打开文件」tab 账本（纯逻辑，可单测）+ localStorage 持久化。
 * 注意与 panel-shell 的页级 tab 区分：那是右侧面板的页面按钮（轨迹/文件/
 * 诊断），这里是文件浏览器内部的多文件预览 tab（视频第三节）。
 * 会话切换时账本整体作废（不同会话的 relPath 无意义），按 sessionId 分键。
 *
 * tab key 的两个互斥域（以 {@link isExternalFilePath} 判别）：
 *   - 工作区相对路径（树内文件）；
 *   - 规范化绝对路径（工作区外单文件只读预览）。
 * v1 持久化数据两域皆可能含（外部单文件预览落地后 openPaths 会写入
 * 规范化绝对路径键并在重启恢复）；绝对路径键是后增形态，读写按字符串
 * 处理、形状兼容，无需升版本。
 */
export interface FileTabsState {
  /** 打开顺序 = tab 顺序。 */
  openPaths: string[]
  /** 激活 tab 的 relPath；null = 空态。 */
  activePath: string | null
}

export const emptyFileTabs: FileTabsState = { openPaths: [], activePath: null }

/** 打开（或激活）一个文件：已在账本内只挪激活位。 */
export function openFile(state: FileTabsState, relPath: string): FileTabsState {
  if (state.openPaths.includes(relPath)) return { ...state, activePath: relPath }
  return { openPaths: [...state.openPaths, relPath], activePath: relPath }
}

/** 关闭 tab：激活位回落到右邻（末尾则左邻），全空回落到 null。 */
export function closeFile(state: FileTabsState, relPath: string): FileTabsState {
  const index = state.openPaths.indexOf(relPath)
  if (index < 0) return state
  const openPaths = state.openPaths.filter(path => path !== relPath)
  let activePath = state.activePath
  if (state.activePath === relPath) {
    activePath = openPaths[Math.min(index, openPaths.length - 1)] ?? null
  }
  return { openPaths, activePath }
}

/** 激活既有 tab。 */
export function activateFile(state: FileTabsState, relPath: string): FileTabsState {
  return state.openPaths.includes(relPath) ? { ...state, activePath: relPath } : state
}

/** 持久化键（按会话分槽）。 */
export const fileTabsKey = (sessionId: string): string => `dsh.filebrowser.v1:${sessionId}`

/** 读账本：坏 JSON/形状漂移回空态（恢复时懒校验由页面拉数据兜底）。 */
export function loadFileTabs(storage: Pick<Storage, 'getItem'>, sessionId: string): FileTabsState {
  try {
    const raw = storage.getItem(fileTabsKey(sessionId))
    if (raw === null) return emptyFileTabs
    const parsed = JSON.parse(raw) as Partial<FileTabsState>
    if (!Array.isArray(parsed.openPaths)) return emptyFileTabs
    const openPaths = parsed.openPaths.filter((item): item is string => typeof item === 'string')
    const activePath = typeof parsed.activePath === 'string' && openPaths.includes(parsed.activePath)
      ? parsed.activePath
      : null
    return { openPaths, activePath }
  } catch {
    return emptyFileTabs
  }
}

/** 写账本（quota/禁用存储静默——只是便利，不是事实来源）。 */
export function saveFileTabs(storage: Pick<Storage, 'setItem'>, sessionId: string, state: FileTabsState): void {
  try {
    storage.setItem(fileTabsKey(sessionId), JSON.stringify(state))
  } catch { /* 尽力而为 */ }
}

/**
 * 从 mux 帧提取与 root 相关的文件路径（阶段三联动刷新用，纯函数便于单测）。
 * 工具视图的 path 有两种形态（上游 presentation.ts 契约：绝对路径原样、
 * 相对路径由 UI 桥相对会话工作区解析），两态都收敛为 relPath：绝对路径按
 * root 前缀剥（root 外的丢弃），裸相对路径直通（拒绝 ../ 开头——root 外）。
 */
export function relPathsUnderRoot(root: string, paths: string[]): string[] {
  const prefix = `${root.replace(/\/+$/, '')}/`
  const out: string[] = []
  for (const path of paths) {
    if (path.startsWith(prefix)) {
      out.push(path.slice(prefix.length))
    } else if (!path.startsWith('/') && !path.startsWith('..')) {
      out.push(path)
    }
  }
  return out
}
