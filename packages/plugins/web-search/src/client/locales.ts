/** Localized copy owned by the web-search card. */

export type WebSearchLocaleKey =
  | 'title' | 'description' | 'enabled' | 'enabledHint' | 'protocol' | 'protocolHint'
  | 'responsesProtocol' | 'anthropicProtocol' | 'baseURL' | 'baseURLHint'
  | 'apiKey' | 'apiKeyHint' | 'apiKeySet' | 'apiKeyUnset'
  | 'model' | 'modelHint' | 'reasoningEffort' | 'reasoningEffortHint'
  | 'requestTimeoutMs' | 'requestTimeoutMsHint' | 'anthropicApiVersion'
  | 'anthropicApiVersionHint' | 'anthropicMaxTokens' | 'anthropicMaxTokensHint'
  | 'anthropicMaxUses' | 'anthropicMaxUsesHint' | 'overridden' | 'reset'
  | 'readOnly' | 'expand' | 'collapse' | 'save' | 'saving' | 'discard'
  | 'unsaved' | 'saveFailed' | 'invalid' | 'invalidNumber'

export const en: Record<WebSearchLocaleKey, string> = {
  title: 'Web search',
  description: 'Provides native web search for models without web access.',
  enabled: 'Enable provider',
  enabledHint: 'The existing web_search tool uses this auxiliary provider when enabled.',
  protocol: 'Protocol',
  protocolHint: 'Protocol spoken by the auxiliary search model endpoint.',
  responsesProtocol: 'OpenAI Responses',
  anthropicProtocol: 'Anthropic Messages',
  baseURL: 'Endpoint',
  baseURLHint: 'Base URL; /responses or /messages is added automatically.',
  apiKey: 'API key',
  apiKeyHint: 'Enter a new key and save; it is stored securely by Credentials and never shown again.',
  apiKeySet: 'Configured',
  apiKeyUnset: 'Not configured',
  model: 'Auxiliary model',
  modelHint: 'Model used only for the native search request; it does not change the chat model.',
  reasoningEffort: 'Reasoning effort',
  reasoningEffortHint: 'OpenAI Responses reasoning effort; leave blank to omit the option.',
  requestTimeoutMs: 'Request timeout (ms)',
  requestTimeoutMsHint: 'Maximum time for one auxiliary search request.',
  anthropicApiVersion: 'Anthropic API version',
  anthropicApiVersionHint: 'Sent as the anthropic-version header.',
  anthropicMaxTokens: 'Anthropic max tokens',
  anthropicMaxTokensHint: 'Maximum generated tokens for a Messages request.',
  anthropicMaxUses: 'Anthropic max uses',
  anthropicMaxUsesHint: 'Maximum native web_search uses in one Messages request.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalid: 'Enter a valid value.',
  invalidNumber: 'Enter a positive integer, or leave blank to use the default.',
}

export const zh: Record<WebSearchLocaleKey, string> = {
  title: '网页搜索',
  description: '为不支持联网的模型提供原生网页搜索能力。',
  enabled: '启用提供方',
  enabledHint: '启用后，现有 web_search 工具会使用这个辅助提供方。',
  protocol: '协议',
  protocolHint: '辅助搜索模型接口使用的协议。',
  responsesProtocol: 'OpenAI Responses',
  anthropicProtocol: 'Anthropic Messages',
  baseURL: '接口地址',
  baseURLHint: '基础地址，插件会自动追加 /responses 或 /messages。',
  apiKey: 'API Key',
  apiKeyHint: '输入新密钥后保存；密钥安全存储在凭据服务中，已有密钥不会回显。',
  apiKeySet: '已配置',
  apiKeyUnset: '未配置',
  model: '辅助模型',
  modelHint: '仅用于辅助搜索请求，不会改变当前对话模型。',
  reasoningEffort: '推理等级',
  reasoningEffortHint: 'OpenAI Responses 推理等级；留空则不发送该选项。',
  requestTimeoutMs: '请求超时（毫秒）',
  requestTimeoutMsHint: '一次辅助搜索请求允许的最长时间。',
  anthropicApiVersion: 'Anthropic API 版本',
  anthropicApiVersionHint: '作为 anthropic-version 请求头发送。',
  anthropicMaxTokens: 'Anthropic 最大 token 数',
  anthropicMaxTokensHint: 'Messages 请求最多生成的 token 数。',
  anthropicMaxUses: 'Anthropic 最大搜索次数',
  anthropicMaxUsesHint: '一次 Messages 请求中原生 web_search 最多使用次数。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalid: '请输入有效值。',
  invalidNumber: '请输入正整数，留空表示使用默认值。',
}
