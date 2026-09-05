# @dsh-desktop/vision

为不接受图片输入的模型补充图片理解能力。主会话的 Provider 和模型保持不变；
插件使用独立配置的视觉 API 生成有界的图片证据文本。是否需要桥接只根据目标
Provider/模型解析出的输入能力判断，不根据模型名称、家族或文本模式猜测。

## 能力判定与桥接策略

插件只在请求确实包含图片时解析目标模型能力。普通文本请求不会触发能力解析，
也不会调用视觉桥。对于包含图片的请求，决策如下：

| 目标模型的 `inputModalities` | 处理 |
| --- | --- |
| 明确包含 `image` | 目标模型原生支持图片，原请求直接发送，不调用视觉桥 |
| 明确存在但不包含 `image` | 目标模型是文本输入路线，调用视觉桥生成图片证据 |
| 成功解析但未声明 `inputModalities` | 按 `unknownCapabilityPolicy` 处理 |
| 能力解析失败 | 保留原错误，不调用视觉桥 |

`unknownCapabilityPolicy` 默认是 `passthrough`：成功解析但能力字段缺失时保持 DSH
的原有语义，交由原 adapter 决定是否接受图片；能力查询失败时保留原错误。
只有显式设置为 `bridge` 时，成功解析但能力未知才会使用视觉桥；不会对解析失败
执行 fail-open 桥接。该设置是未知状态的兼容策略，不是模型匹配规则。

已持久化的旧键 `upstream`、`families`、`models` 会被无害忽略，不会参与
路由判定，也不需要破坏性迁移；用户可以保留或手动删除它们。

Host 半注册 `vision` settings namespace 和独立的图片桥接准入服务，不会
篡改 Provider 的原生 `inputModalities`。插件同时提供 `imageInputTransform`
服务：正式的 LLM 输入转换 seam 可以传入已解析的 `inputModalities`，并在一次
模型 dispatch 前取得一份派生的纯文本 messages。派生结果只属于当前请求，不会
追加到 session，也不会在界面显示为 Context injection。

在没有正式输入转换 seam 的旧运行时中，插件才会安装 `llm/stream` + `MARKER`
兼容桥，将同一份派生 messages 重新交给原 LLM 服务。该路径保留原 Provider/模型，
但属于兼容边界；升级到支持 `registerInputTransform` 的运行时后会优先注册正式
转换服务，不再安装兼容监听器。

兼容重入逻辑独立放在 `src/legacy-stream.ts`。图片转写在途任务与成功缓存分开管理：
取消一个调用方不会中止其他调用方共享的转写，最后一个调用方离开才取消任务；失败和
取消结果不进入缓存。修改设置后新请求使用新配置，旧请求可完成但不会回填新缓存；
卸载插件会取消所有在途任务。

插件只处理图片，不支持也不声明任何视频输入配置。它没有自定义
`read_image` 工具；图片附件统一使用 dsh 的 `attachments.readImage`，路径访问和权限
仍由官方工具与附件服务负责。

客户端只显示一个 API key 输入框；新安装使用内部凭据引用
`DSH_VISION_API_KEY`，引用名本身不会作为可编辑设置暴露。`apiKeyEnv` 仅作为隐藏的
legacy 配置保留：已有显式引用继续优先使用，不会自动迁移或改写 settings。对于没有
显式自定义引用的旧配置，Host 按 `DSH_VISION_API_KEY` → `SELF_API_KEY` 顺序兼容读取，
新引用一旦有值就不会读取旧引用。

API key 通过 credentials service 管理，永远不会写入普通 settings。Host 挂载了
credentials service 时只通过它解析（它负责继承环境、受管凭据文件和 `.env` 层级）；
只有在 credentials service 不可用的最小组合中，才通过 launch environment 读取环境回退。
客户端设置卡支持暂存、保存、放弃、重置和 revision-fenced 写入，密钥从不回显。

## Model Experience

### 图片证据

#### What the model sees

目标文本模型在本次 dispatch 中看到由图片替换而来的
`[图片证据]\n<bounded structured description>`。原始 session 消息保持不变，
不会新增插件 user message 或可见 Context injection。辅助视觉模型使用插件设置
中的结构化转写提示词；API key、Endpoint 和附件字节不会进入主模型上下文。

#### Token effect

仅含图片的请求增加有界证据文本；多图批次受单图和请求大小上限约束。证据只在
当前模型调用中存在，不改变后续会话历史；重复请求是否复用视觉结果由进程内
缓存决定，图片及影响转写的配置构成缓存身份。关注点只参与首次转写提示，后续用户
消息不会使历史图片逐轮重新转写；显式修改设置会清空缓存。

#### KV Cache effect

原始消息前缀保持稳定；图片证据属于本次派生请求，不写回 session，因此不会
污染后续请求的 KV 前缀。进程内缓存命中时可避免同一图片的重复视觉调用。

## Known Limitations and Deferred Work

- `imageInputTransform` 服务和 `llm.registerInputTransform` 目前采用结构适配，
  以兼容不同 dsh 运行时版本；正式 seam 稳定后可移除 `llm/stream` 兼容路径。
- 证据不写入 session，因此进程重启后不会复用进程内缓存；新的图片请求会按需
  再次调用视觉桥。
