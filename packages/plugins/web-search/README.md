# @dsh-desktop/web-search

DSH 的联网搜索能力补全插件。它只向 `ctx.web` 注册一个
`WebSearchProvider`，由辅助模型调用 OpenAI Responses API 或 Anthropic
Messages API 的原生 `web_search` 服务端工具，并把结构化来源返回给现有的
`web_search` 工具。主模型 provider/model 与工具 schema 都不由本插件修改。

插件的 settings namespace 是 `web-search`，浏览器半在 Plugins → Plugin
configuration 中提供可视化配置。新安装使用内部 credential reference
`DSH_WEB_SEARCH_API_KEY`；API key 只通过 credentials 域写入，设置文档中只保存
reference。旧的 `apiKeyEnv` 仍作为隐藏字段兼容读取，不会自动迁移或写入新的
settings。默认按 `DSH_WEB_SEARCH_API_KEY` → `DEEPSEEK_API_KEY` 读取，新的引用有值
时优先；显式 `SELF_API_KEY` 或其他自定义引用只读取自身。

credentials service 已挂载时，Host 只通过它解析凭据，不会用 ambient 环境绕过其
优先级。credentials service 不可用时，才读取 `launchEnvironment` snapshot；不会
直接读取 `process.env`。表单采用 staged save、discard、field reset 与
revision-fenced settings writes。

响应必须包含 API 返回的结构化来源（Responses 的 `url_citation` 或
`web_search_call.action.sources`，Anthropic 的 `web_search_tool_result`），
不会从模型散文中提取 URL。响应体有硬字节上限，所有请求都遵守调用方取消
和插件自己的超时。

开发命令：

```bash
pnpm --filter @dsh-desktop/web-search build
pnpm --filter @dsh-desktop/web-search typecheck
pnpm --filter @dsh-desktop/web-search test
```

## Model Experience

### `web_search` 工具结果

#### What the model sees

本插件不新增工具或提示词。现有 `dsh-tool-web` 将辅助搜索的可选答案与经过
校验、去重的 URL/title/snippet/date 来源渲染给主模型；没有结构化来源时调用
失败，不把模型散文中的 URL 冒充为引用。

#### Token effect

注册本身为零；每次调用按查询、可选答案和 `dsh-tool-web` 的来源数量上限增加
工具调用与结果 token。

#### KV Cache effect

仅追加工具调用和结果；provider 设置不改变稳定的 `web_search` schema，既有
请求前缀保持不变。

## Known Limitations and Deferred Work

- `enabled: false` 只让被选 provider 不可用，不会自动切回官方 provider。
- 辅助模型的秘密无关请求 envelope 未写进 Session；查询、规范化结果与 UI
  presentation metadata 已由标准 tool/call 和 tool/result 持久化。
