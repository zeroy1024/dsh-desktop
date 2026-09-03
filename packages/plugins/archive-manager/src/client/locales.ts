/** 本插件词典命名空间；key 集合是 zh/en 两份字典的并集。 */
export const NS = 'archive-manager'

export const zh = {
  nav: '归档管理',
  title: '归档的会话',
  description: '归档的会话已从侧边栏隐藏，但会话记录仍完整保留，可在此恢复到侧边栏。',
  empty: '没有归档的会话',
  restore: '恢复',
  restoring: '恢复中…',
  restoreAria: '恢复会话“{name}”',
  unknownSession: '未知会话',
  noWorkspace: '未分组',
  archivedAt: '归档',
  lastActivity: '最后活跃',
  sortBy: '排序',
  sortArchivedAt: '归档时间',
  sortUpdatedAt: '最后活跃时间',
  sortAsc: '升序 ↑',
  sortDesc: '降序 ↓',
  groupOn: '按工作区分组',
  groupOff: '不分组',
  errorRestore: '恢复失败：{message}',
  errorUnsupported: '当前 dsh 版本已不支持恢复（内部接口变更），列表仅作只读展示。',
} as const satisfies Record<string, string>

export const en = {
  nav: 'Archived sessions',
  title: 'Archived sessions',
  description: 'Archived sessions are hidden from the sidebar. Their logs remain intact and can be restored here.',
  empty: 'No archived sessions',
  restore: 'Restore',
  restoring: 'Restoring…',
  restoreAria: 'Restore session “{name}”',
  unknownSession: 'Unknown session',
  noWorkspace: 'Ungrouped',
  archivedAt: 'Archived',
  lastActivity: 'Last activity',
  sortBy: 'Sort',
  sortArchivedAt: 'Archive time',
  sortUpdatedAt: 'Last activity',
  sortAsc: 'Ascending ↑',
  sortDesc: 'Descending ↓',
  groupOn: 'Group by workspace',
  groupOff: 'No grouping',
  errorRestore: 'Restore failed: {message}',
  errorUnsupported: 'This dsh build no longer supports restoring (internal API changed); the list is read-only.',
} as const satisfies Record<string, string>

export type DictionaryKey = keyof typeof zh
