# 模型级配置与混合 API Provider

## 实施方案与边界

原生 `@deepseek-ai/dsh-llm-pi-ai` 是唯一 Provider 所有者：配置、鉴权、OAuth、模型目录、发现、重试和调用快照继续走原链路。`0020-llm-pi-ai-model-policy.patch` 在原配置解析和协议分发中增加模型级 API、思考能力和默认值。`model-selection-direct` 客户端插件消费原生模型元数据，不再把“思考”假定为等级枚举。

上游变更只通过已登记补丁和 `sync:upstream` 套用，不直接编辑 `upstream/`，不维护 HTTP 代理或 SDK 原型修改。当前上游没有覆盖配置解析、模型解析和请求编码的完整插件扩展点；为这几个字段建立通用钩子框架反而更大，因此采用聚焦原生增量，而非第二套 Provider。上游具备等价能力时移除补丁。

原生 `ui-settings-models` 保持启用，原模型设置页及首次启动声明/API Key 引导保留。不覆盖其表单，也不追加新配置页面。新 Provider 位于原生命名空间，因此原生已有的连接和凭据字段可以编辑；**模型级新增字段仍通过配置文件或 settings API 维护**，不是表单自动生成的新控件。目录 Provider 保留原有鉴权；自定义混合协议路由使用原生 API Key 链路。

## 配置归属

配置唯一归属是 `llm-pi-ai.providers`。通过 settings API 保存用户层时使用 revision 乐观并发校验；凭据通过 credentials API 保存，配置仅持有 `apiKeyEnv` 引用。已删除 `@dsh-desktop/model-config` 插件，不再保留第二套 schema、迁移预览或旧配置订阅。

| 归属 | 配置 |
| --- | --- |
| Provider | 显示名称、Base URL、凭据引用、默认 API、可选 reasoning 回退、headers/compat/超时 |
| Model | ID/名称、API 覆盖、思考能力与默认值、上下文、输出上限、输入模态、compat、等级线协议映射 |

API 类型使用与 Provider 相同的标识：`openai-completions`（Chat）、`anthropic-messages`、`openai-responses`。优先级为模型 API → Provider API → 目录模型 API。`models[]` 和 `modelOverrides` 均支持新增字段；没有显式 API 覆盖的目录模型继续使用目录 Provider 的原始分发实现。

已有 `baseURL` 默认保持原义，不做路径改写。共享入口显式设置 `baseURLMode: "api-root"` 时，可带末尾 `/v1`：Chat/Responses 使用 root + `/v1`，Anthropic SDK 使用 root 并自行附加 `/v1/messages`。模型的 `baseURL` 是原样传给 SDK 的精确覆盖，优先于共享入口；非标准路径应使用此项而不是依赖猜测。

## 思考状态与默认值

| mode | 选择器 | 请求行为 |
| --- | --- | --- |
| `inherit` | 已安装模型目录元数据 | SDK 原生处理；未知自定义模型需显式声明能力 |
| `levels` | 声明的 levels；可选 `allowOff` | SDK 等级映射，可用 `reasoningEfforts` 覆盖线协议值 |
| `toggle` | 关闭 / 开启 | 通过显式 wire preset 编码开关 |
| `always-on` | “始终开启”只读状态 | 固定开启，不提供关闭选择 |
| `none` | 不显示思考控制 | 不发送思考选择 |

优先级：会话显式选择 → 模型 default → **受支持的** Provider reasoning → 不指定。Provider 默认等级不在模型能力集合中时不向下透传。切换到不同模型采用目标模型默认值；同模型已有选择保留。声明了默认值的模型不显示 Default；未声明有效默认值的可选模型显示“跟随服务商”。

wire preset：

- `native`：SDK 原生等级编码。
- `anthropic-adaptive`：`thinking.type = adaptive / disabled`，用于用户选择该协议的开关模型。
- `anthropic-enabled`：`thinking.type = enabled / disabled`，用于固定开启或开关模型，不用于 token-budget 等级模型。
- `chat-thinking`：Chat `thinking.type = enabled / disabled`。

没有根据模型名称猜测能力、没有发送失败后改写请求重试。能力和 wire 由配置明确指定；示例模型名不构成远端支持承诺。Responses 的无等级开关尚无独立 preset，配置校验会拒绝不匹配的配置；其原生可用等级（含 off）使用 `levels`。

下面是 **`llm-pi-ai.providers.self`** 对象的示例（命名空间外层只有 `providers`，没有 `version` 或 `migrations`；将 URL、模型 ID 和能力改为自己的真实值）：

```json
{
  "displayName": "Self",
  "baseURL": "https://api.example.com/v1",
  "baseURLMode": "api-root",
  "apiKeyEnv": "SELF_API_KEY",
  "api": "openai-responses",
  "models": [
    {
      "id": "chat-model",
      "api": "openai-completions",
      "thinking": { "mode": "levels", "levels": ["low", "high"], "default": "high" },
      "compat": { "supportsReasoningEffort": true }
    },
    {
      "id": "minimax-m3",
      "api": "anthropic-messages",
      "thinking": { "mode": "toggle", "default": "on", "wire": "anthropic-adaptive" }
    },
    {
      "id": "kimi-k2.7-code",
      "api": "anthropic-messages",
      "thinking": { "mode": "always-on", "wire": "anthropic-enabled" }
    },
    {
      "id": "responses-model",
      "thinking": { "mode": "levels", "levels": ["high"], "default": "high" }
    }
  ]
}
```

## 迁移兼容

没有自动迁移、迁移预览函数或启动诊断。旧 `desktop-model-config` 命名空间不再被读取，其中的 Provider 不提供运行时路由，`migrations` 也不再隐藏选择器中的来源组。删除插件不会删除用户的配置、Key 或历史会话。

若曾使用旧命名空间，应先备份，再按上面的原生格式人工迁入 `llm-pi-ai.providers`，保留 Provider ID、模型 ID 和凭据引用。原共享 URL 语义对应 `baseURLMode: "api-root"`；Provider 的 `reasoning: "on"` 应转成对应模型的 `thinking.default: "on"`。旧 `outputCapacity` 与 `maxTokens` 不能直接盲目复制，应核对原生容量与请求上限语义。验证后再自行清理旧配置。

既有三个原生 Provider 无需迁移即可继续工作，合并路由属于单独的显式配置操作。桌面版与 CLI 共用配置时，未打补丁的 CLI 不保证识别新字段；不要未经验证将这种配置交给未适配版本。

## 验证与维护

- 原生配置/schema、默认值、禁用不受支持的选择测试。
- loopback mock HTTP 使用真实 SDK 的 Chat、Anthropic、Responses 序列化与 SSE 消费，验证同一凭据、路径、默认等级、自定义线协议映射、开关/固定开启参数。
- 选择器装配测试验证直接使用原生模型目录；交互测试验证默认值、toggle 和固定状态。原生配置与三协议 HTTP 回归测试保留在 `model-selection-direct/tests/native-model-config.spec.ts`，不需要额外 Host 插件。
- 独立临时 `DSH_HOME` 启动完整 staged desktop profile 做启动冒烟。不接触用户 Key，不调用付费模型。
- 补丁携带原生策略回归测试，随 `pnpm test:upstream-patches` 执行；升级时复核 catalog-owned 分发、OAuth、SDK `onPayload`、settings revision 和模型目录默认值语义。

执行 `pnpm build` 或分别构建插件后 `pnpm stage:plugins`，重启开发应用加载 Host 半。仅刷新浏览器不能加载 Host 代码更新。
