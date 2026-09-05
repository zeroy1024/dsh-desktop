/**
 * `review` 命名空间词典。键集即契约：两份词典必须同键齐备
 * （panel-shell/file-browser 同款收口，键联合类型承担职责）。
 * 插值占位符为 {name} 单花括号（上游 locale translate 的替换语法）。
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'review'

/** The review dictionary key set (the source of truth for both locales). */
export type ReviewKey =
  | 'page.title'
  | 'mode.session'
  | 'mode.git'
  | 'summary.actions'
  | 'summary.loading'
  | 'summary.fileCount'
  | 'summary.editCount'
  | 'summary.truncated'
  | 'summary.markAll'
  | 'summary.unmarkAll'
  | 'summary.sortByChanges'
  | 'summary.sortByPath'
  | 'action.refresh'
  | 'action.copyDiff'
  | 'action.copyFailed'
  | 'action.copyPath'
  | 'action.markReviewed'
  | 'action.unmarkReviewed'
  | 'action.send'
  | 'action.clear'
  | 'action.remove'
  | 'action.revert'
  | 'action.revertConfirm'
  | 'git.loading'
  | 'git.error'
  | 'git.unavailable'
  | 'git.clean'
  | 'git.truncated'
  | 'git.revertFailed'
  | 'git.binary'
  | 'empty.title'
  | 'empty.guide'
  | 'error.load'
  | 'error.retry'
  | 'drafts.title'
  | 'drafts.send'
  | 'drafts.clear'
  | 'drafts.sent'
  | 'drafts.sendFailed'
  | 'edit.write'
  | 'edit.edit'
  | 'edit.other'
  | 'edit.ordinal'
  | 'diff.expand'
  | 'diff.collapse'
  | 'diff.comment'
  | 'diff.commentPlaceholder'
  | 'diff.commentSubmit'
  | 'diff.commentCancel'
  | 'comments.header'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<ReviewKey, string> = {
  'page.title': '审查',
  'mode.session': '会话内改动',
  'mode.git': '工作区改动',
  'summary.actions': '审查选项',
  'summary.loading': '加载中…',
  'summary.fileCount': '{n} 个文件',
  'summary.editCount': '{n} 次编辑',
  'summary.truncated': '会话过长，仅汇总最近的改动',
  'summary.markAll': '全部标记已审',
  'summary.unmarkAll': '全部取消已审',
  'summary.sortByChanges': '按改动量排序',
  'summary.sortByPath': '按路径排序',
  'action.refresh': '刷新',
  'action.copyDiff': '复制此文件 diff',
  'action.copyFailed': '复制失败',
  'action.copyPath': '复制路径',
  'action.markReviewed': '标记已审',
  'action.unmarkReviewed': '取消已审',
  'action.send': '发送给 agent',
  'action.clear': '清空草稿',
  'action.remove': '删除此条',
  'action.revert': '撤销',
  'action.revertConfirm': '确认',
  'git.loading': '读取工作区改动…',
  'git.error': '读取工作区改动失败',
  'git.unavailable': '当前会话的工作目录不是 git 仓库。',
  'git.clean': '工作区没有未提交的改动。',
  'git.truncated': '改动过多，diff 已截断',
  'git.revertFailed': '撤销失败，请重试',
  'git.binary': '二进制文件，无行级 diff',
  'empty.title': '暂无可审查的改动',
  'empty.guide': 'agent 在本会话中写入或编辑文件后，改动会按文件汇总在这里。',
  'error.load': '加载会话改动失败',
  'error.retry': '重试',
  'drafts.title': '审查意见草稿 · {n}',
  'drafts.send': '发送给 agent',
  'drafts.clear': '清空',
  'drafts.sent': '已发送 {n} 条审查意见',
  'drafts.sendFailed': '发送失败，请重试',
  'edit.write': '写入',
  'edit.edit': '编辑',
  'edit.other': '文件改动',
  'edit.ordinal': '第 {n} 次',
  'diff.expand': '… 其余 {n} 行',
  'diff.collapse': '收起',
  'diff.comment': '针对此行写审查意见',
  'diff.commentPlaceholder': '审查意见…',
  'diff.commentSubmit': '添加',
  'diff.commentCancel': '取消',
  'comments.header': '请处理以下审查意见：',
}

/** English dictionary. */
export const en: Record<ReviewKey, string> = {
  'page.title': 'Review',
  'mode.session': 'Session changes',
  'mode.git': 'Workspace changes',
  'summary.actions': 'Review options',
  'summary.loading': 'Loading…',
  'summary.fileCount': '{n} files',
  'summary.editCount': '{n} edits',
  'summary.truncated': 'Long session — showing only recent changes',
  'summary.markAll': 'Mark all reviewed',
  'summary.unmarkAll': 'Unmark all reviewed',
  'summary.sortByChanges': 'Sort by change size',
  'summary.sortByPath': 'Sort by path',
  'action.refresh': 'Refresh',
  'action.copyDiff': 'Copy file diff',
  'action.copyFailed': 'Copy failed',
  'action.copyPath': 'Copy path',
  'action.markReviewed': 'Mark reviewed',
  'action.unmarkReviewed': 'Unmark reviewed',
  'action.send': 'Send to agent',
  'action.clear': 'Clear drafts',
  'action.remove': 'Remove',
  'action.revert': 'Revert',
  'action.revertConfirm': 'Confirm',
  'git.loading': 'Reading workspace changes…',
  'git.error': 'Failed to read workspace changes',
  'git.unavailable': 'The working directory of this session is not a git repository.',
  'git.clean': 'No uncommitted changes in the workspace.',
  'git.truncated': 'Too many changes — diff truncated',
  'git.revertFailed': 'Revert failed — try again',
  'git.binary': 'Binary file — no line diff',
  'empty.title': 'No changes to review',
  'empty.guide': 'When the agent writes or edits files in this session, changes will be grouped here by file.',
  'error.load': 'Failed to load session changes',
  'error.retry': 'Retry',
  'drafts.title': 'Review comment drafts · {n}',
  'drafts.send': 'Send to agent',
  'drafts.clear': 'Clear',
  'drafts.sent': 'Sent {n} review comments',
  'drafts.sendFailed': 'Send failed — try again',
  'edit.write': 'write',
  'edit.edit': 'edit',
  'edit.other': 'file change',
  'edit.ordinal': '#{n}',
  'diff.expand': '… {n} more lines',
  'diff.collapse': 'Collapse',
  'diff.comment': 'Comment on this line',
  'diff.commentPlaceholder': 'Review comment…',
  'diff.commentSubmit': 'Add',
  'diff.commentCancel': 'Cancel',
  'comments.header': 'Please address the following review comments:',
}
