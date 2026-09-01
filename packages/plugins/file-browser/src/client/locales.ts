/**
 * `file-browser` 命名空间词典。键集即契约：两份词典必须同键齐备
 * （panel-shell/stub 同款收口，键联合类型承担职责）。
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'file-browser'

/** The file-browser dictionary key set (the source of truth for both locales). */
export type FileBrowserKey =
  | 'page.title'
  | 'tree.aria'
  | 'tree.filter'
  | 'tree.refresh'
  | 'tree.refreshing'
  | 'tree.hide'
  | 'tree.show'
  | 'tree.resize'
  | 'tree.truncated'
  | 'tree.error'
  | 'tree.copySelected'
  | 'tree.emptyFilter'
  | 'tabs.aria'
  | 'tabs.close'
  | 'preview.empty.title'
  | 'preview.empty.guide'
  | 'preview.source'
  | 'preview.rendered'
  | 'preview.copy'
  | 'menu.open'
  | 'menu.openSystem'
  | 'menu.copyPath'
  | 'status.loading'
  | 'status.large'
  | 'status.binary'
  | 'status.plain'
  | 'error.session-not-found'
  | 'error.not-found'
  | 'error.bad-path'
  | 'error.forbidden'
  | 'error.symlink-escape'
  | 'error.is-directory'
  | 'error.unreadable'
  | 'error.network'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FileBrowserKey, string> = {
  'page.title': '文件',
  'tree.aria': '工作区文件树',
  'tree.filter': '筛选文件…',
  'tree.refresh': '刷新目录',
  'tree.refreshing': '刷新中…',
  'tree.hide': '隐藏文件树',
  'tree.show': '显示文件树',
  'tree.resize': '调整文件树宽度',
  'tree.truncated': '条目过多，列表已截断',
  'tree.error': '无法读取该目录',
  'tree.copySelected': '复制所选路径',
  'tree.emptyFilter': '无匹配文件',
  'tabs.aria': '已打开文件',
  'tabs.close': '关闭',
  'preview.empty.title': '打开文件',
  'preview.empty.guide': '从工作区目录树中选择文件',
  'preview.source': '查看源代码',
  'preview.rendered': '渲染预览',
  'preview.copy': '复制',
  'menu.open': '打开',
  'menu.openSystem': '用系统默认应用打开',
  'menu.copyPath': '复制路径',
  'status.loading': '加载中…',
  'status.large': '文件过大，无法预览',
  'status.binary': '二进制文件，无法预览',
  'status.plain': '为保持流畅，大文件以纯文本显示',
  'error.session-not-found': '会话不存在或没有工作目录',
  'error.not-found': '文件不存在（可能已被删除）',
  'error.bad-path': '非法路径',
  'error.forbidden': '请求被拒绝',
  'error.symlink-escape': '该符号链接指向工作区之外，无法读取',
  'error.is-directory': '这是一个目录',
  'error.unreadable': '无法读取文件',
  'error.network': '与本地服务的连接失败',
}

/** English dictionary. */
export const en: Record<FileBrowserKey, string> = {
  'page.title': 'Files',
  'tree.aria': 'Workspace file tree',
  'tree.filter': 'Filter files…',
  'tree.refresh': 'Refresh directories',
  'tree.refreshing': 'Refreshing…',
  'tree.hide': 'Hide file tree',
  'tree.show': 'Show file tree',
  'tree.resize': 'Resize file tree',
  'tree.truncated': 'Too many entries — list truncated',
  'tree.error': 'Cannot read this directory',
  'tree.copySelected': 'Copy selected paths',
  'tree.emptyFilter': 'No matching files',
  'tabs.aria': 'Open files',
  'tabs.close': 'Close',
  'preview.empty.title': 'Open a file',
  'preview.empty.guide': 'Select a file from the workspace tree',
  'preview.source': 'View source',
  'preview.rendered': 'Rendered preview',
  'preview.copy': 'Copy',
  'menu.open': 'Open',
  'menu.openSystem': 'Open with default app',
  'menu.copyPath': 'Copy path',
  'status.loading': 'Loading…',
  'status.large': 'File is too large to preview',
  'status.binary': 'Binary file — no preview',
  'status.plain': 'Shown as plain text to keep large files responsive',
  'error.session-not-found': 'Session not found or has no working directory',
  'error.not-found': 'File not found (it may have been deleted)',
  'error.bad-path': 'Invalid path',
  'error.forbidden': 'Request refused',
  'error.symlink-escape': 'This symlink escapes the workspace',
  'error.is-directory': 'This is a directory',
  'error.unreadable': 'Cannot read file',
  'error.network': 'Lost connection to the local agent',
}
