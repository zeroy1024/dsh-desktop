/** 本插件词典命名空间；key 集合是 zh/en 两份字典的并集。 */
export const NS = 'rewind'

export const zh = {
  action: '撤回编辑',
  actionAria: '撤回并编辑该消息',
  copy: '复制',
  copied: '已复制',
  extraBlock: '附加内容块',
  jsonTruncated: '… 已截断，共 {total} 字符',
  referenceSummary: '引用会话 · {labels}',
  referenceSeparator: '、',
  confirmTitle: '撤回该消息及其后的所有回复？',
  confirmHint: '消息内容将回到输入框，可编辑后重新发送。',
  confirm: '撤回',
  cancel: '取消',
  retry: '重试',
  running: '会话运行中，请先停止再撤回',
  errorNotLive: '会话未激活，请先发送任意消息后再撤回',
  errorBoundary: '撤回点跨越了历史压缩段，无法撤回到该位置',
  errorInvalid: '撤回点无效',
  errorInputBusy: '输入框正在提交，请完成后重试',
  errorImagesUnavailable: '暂时无法恢复图片，请重新打开会话后重试',
  errorImagesRejected: '输入框无法接收恢复的图片',
  errorHttp: '撤回失败（HTTP {status}）',
  errorGeneric: '撤回失败：{message}',
} as const satisfies Record<string, string>

export const en = {
  action: 'Rewind & edit',
  actionAria: 'Rewind and edit this message',
  copy: 'Copy',
  copied: 'Copied',
  extraBlock: 'Extra content block',
  jsonTruncated: '… truncated, {total} chars total',
  referenceSummary: 'Referenced session · {labels}',
  referenceSeparator: ', ',
  confirmTitle: 'Rewind this message and every reply after it?',
  confirmHint: 'The message and its images return to the composer for editing and resending.',
  confirm: 'Rewind',
  cancel: 'Cancel',
  retry: 'Retry',
  running: 'The session is running — stop it before rewinding',
  errorNotLive: 'Session is not active — send any message first, then rewind',
  errorBoundary: 'The rewind point crosses a compaction boundary',
  errorInvalid: 'Invalid rewind point',
  errorInputBusy: 'The composer is submitting. Please retry when it finishes.',
  errorImagesUnavailable: 'Images cannot be restored right now. Reopen the session and retry.',
  errorImagesRejected: 'The composer could not accept the restored images.',
  errorHttp: 'Rewind failed (HTTP {status})',
  errorGeneric: 'Rewind failed: {message}',
} as const satisfies Record<string, string>

export type DictionaryKey = keyof typeof zh
