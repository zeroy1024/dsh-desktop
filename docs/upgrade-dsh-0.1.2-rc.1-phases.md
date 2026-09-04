# 阶段实施计划：dsh v0.1.1-rc.2 → v0.1.2-rc.1

> 前置文档：[upgrade-dsh-0.1.2-rc.1.md](upgrade-dsh-0.1.2-rc.1.md)（逐项方案与依据）。
> 已确认决策：**rewind 保留原地截断语义**（重做 0012/0013；上游 fork 留作后续增强）。
> 分支：`upgrade/dsh-v0.1.2-rc.1`。工作量估算：**约 8–11 人日**（不含 CI 等待）。

## 进度记录（实时更新）

- ✅ **阶段 0 完成**：基线四项全绿（`.ci-artifacts/baseline-rc2/` 存档）；patches.yml 暂摘（留 0004）；commit `9a19ca0`。
- ✅ **阶段 1 完成（M0）**：submodule → `dsh-v0.1.2-rc.1`（commit `ef32f87`）；sync 全量绿；vendor 锁重生成（commit 中）；`ci:verify-vendor-lock`/`ci:probe-native` 绿；bin.js ready 行带 token 实测确认。configTrees 缺 presets 数据**不致命**（观察项）。
- ✅ **阶段 2 完成**：commit `56f0a52`。要点：inject 的 runtime → `dsh-client-ui-renderer`（+ desktop-frame 加 workspace-controller、file-browser/rewind 加 session-controller）；plugin-kit PLATFORM_MODULES 加 store、PRELOADED 清空；vision/web-search 迁 `SettingsProvider.installSection`（ns 直接字符串、ctx.get('settings') 可选服务）+ CSS 镜像同步；rewind/vision 各一个绑定 0011/0012 的集成 spec 加迁移期 skip（阶段 6/7 恢复）。
- ✅ **阶段 3 完成（M1）**：commit `9259419`。要点：主进程 `loadURL(ready.url)` 透传 token（`agentReadyUrl` 模块状态、exit 清空）；smoke-dsh 实现 303+cookie 交接（undici 无 cookie jar）；CSP `base-uri 'none'→'self'`（0.1.2 主文档自带 `<base href="/">`，'none' 会拦截）。**M1 验收超预期**：smoke-electron startup+restart 双哨兵绿、desktop-frame 按钮簇断言绿（不依赖 0006）。
- 🔧 **阶段 4 进行中（0006 重做）**——已验证的续做要点：
  - **旧补丁认知修正**：`CENTER_MIN=640` 在 rc.2 就存在，0006 自己调成 360；`columns.ts`/`service.ts` 宿主两版逐字未变。
  - columns.ts 目标全文已写好并验证（0004 的 320 已并入其中；含 PANEL_MIN=320/PANEL_DEFAULT=480/normalizePanelWidth/四参 computeColumns 五档让位链）。
  - service.ts 可直接 `git apply --include='*/service.ts'` 套旧 0006（宿主未变）。
  - 待重适配：`AppFrame.tsx`（PropsRenderSlots 加 'panel'、StaticSlot memo 四槽边界、DragHandle panel 侧、computeColumns 四参、panelExpanded/overlay 全屏覆盖语义、grid 四列）、`AppFrame.module.css`（四列轨 + 折叠轨变量缝 + overlay 呈现）、`index.ts`（SlotMap 声明 'panel'——新版 declaring-is-claiming 要求在同一 register() children 声明）、`stores.ts`（panel/panelExpanded + actions，defineStore 版）+ 4 个测试文件。
  - **流程教训**：改完主进程源码必须 `pnpm --filter @dsh-desktop/desktop build` 再跑 smoke（M1 的挂载超时假象就是旧产物导致）；upstream 内做 0006 时注意 cwd（曾因 `git -C` 混用把进度 diff 写错路径——columns 内容可从本会话恢复，无实际损失）。
  - 0004/0006 收束策略：columns 的 320 已并入 0006 目标状态，最终从 patches.yml 移除 0004 并在 0006 reason 写明吸收。


## 全局纪律（每阶段都适用）

1. **commit 粒度**：每个补丁重做 = 一个独立 commit（补丁文件 + `patches.yml` reason 更新 + 上游测试适配）；每个阶段末尾是一个可回滚点。
2. **补丁迭代循环**：补丁文件每变更一次 → `pnpm sync:upstream`（`dev.ts` 的 `.upstream-commit` 指纹链要求全量同步才认；迭代期可用 `--skip-pack` 加速，但每阶段收尾必须全量）→ `pnpm rehearse:queue` → `pnpm test:upstream-patches`。
3. **验收门槛**：阶段验收 = 下表所列命令全部绿 + 人工验证项核对通过，才进入下一阶段。
4. **合入策略**：全部阶段完成后不直接合 main；跟随上游 rc 序列（`pnpm view @deepseek-ai/dsh versions`）至 **0.1.2 stable** 后重跑阶段 9 回归，再合入。若上游发 rc.2+，按「阶段 1 重基 + 受影响补丁增量适配」处理。
5. upstream 工作树的补丁套用产物是可再生的（补丁文件在 `patches/` 留底），还原操作（阶段 0）无数据丢失风险。

- ✅ **阶段 5 大部完成**：commit `2146926`（0007/0008/0009）。**0005 未做**（活动分组缝迁 ui-chat，见下）。
- ✅ **阶段 6 完成**：commit `a2bd925`（0010/0011 + sync 同版本刷新修复 + vision 集成测试恢复全绿）。sync 脚本修复：pnpm 对同版本 file: tarball 即使 --force 也沿用已安装实体，installCli 先移除本地包实体再安装。
- ✅ **阶段 7 部分完成**：0012 重做并全绿（10 测试；surface.ts 冲突=import 区合并；测试访问器 `session.events`→`session.snapshotEvents()`；补丁文件已生成未登记 patches.yml、未 commit）。**0013 未做**——重大架构变化：session-controller 的 Session 重构为 `eventSource` 统一事件源（`prependWindow`/`appendLive` 走 `this.eventSource.prepend/append(entry)`，conversation 装配移到 feed 订阅链），旧 0013 的 `conversation.replaceWindow/append` 直接落点**不存在**；需要在 eventSource→装配管线中重新设计可见性过滤（研究 packages/api/session-controller/src/client/sessions/ 的 event-source 与装配订阅者）。
- 🔧 **剩余项**：0013（架构重设计）、0005（活动分组缝迁 ui-chat——apply/slots/ChatNodeSeat 组员渲染变体/chatFlowGrouping 服务 + locales + 测试）、0001/0014/0015 外围、阶段 9/10。

## 阶段总览

| 阶段 | 内容 | 里程碑 | 估算 |
| --- | --- | --- | --- |
| 0 | 基线记录 + 补丁队列整理 | 基线档案 | 0.5d |
| 1 | submodule bump + vendor 闭包重建 | M0 新版闭包可跑 | 0.5–1d |
| 2 | 插件包名迁移 + plugin-kit 镜像 | 构建链绿 | 0.5–1d |
| 3 | 宿主 token 适配 + 验收工具适配 | **M1 无补丁基线恢复** | 1d |
| 4 | 0006+0004 布局大件 + panel-shell | **M2 桌面壳恢复** | 1.5–2d |
| 5 | 0005→0008→0009→0007 会话流 | **M3 会话流恢复** | 1.5d |
| 6 | 0010→0011 agent 链路 | — | 0.5–1d |
| 7 | 0012→0013 rewind（决策 A） | **M4 rewind 恢复** | 1.5–2d |
| 8 | 0001→0014→0015 外围 + 插件联调收尾 | **M5 功能全量恢复** | 1–1.5d |
| 9 | 全量回归 + 打包 + 三平台 CI | **M6 可发布候选** | 1d |
| 10 | 文档/ADR/合入 | 完成 | 0.5d |

---

## 阶段 0：基线与队列整理（0.5d）

**任务**
1. 在 main（或本分支基点）记录全量基线：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm ci:smoke:dsh` 输出存档到 `.ci-artifacts/baseline-rc2/`（gitignore 域）。
2. `patches/patches.yml` 暂摘 13 个补丁（仅保留 0004），文件本体不动；在 `patches.yml` 顶部加临时注记「0.1.2 迁移期摘除，见 upgrade-dsh-0.1.2-rc.1-phases.md」。
3. 还原 upstream 工作树到 HEAD（丢弃已套用补丁的可再生改动）：`git -C upstream restore .`（先 `git -C upstream status --short` 留档对照）。

**验收**
- `git -C upstream status --short` 为空；`pnpm rehearse:queue` 绿（单补丁队列正套/反撤净）。
- 基线档案存在且含四项命令结果。

**交付**：commit「chore: 暂摘补丁队列，准备 0.1.2 迁移基线」。

## 阶段 1：上游闭包重建（0.5–1d）

**任务**
1. submodule bump：`git -C upstream checkout dsh-v0.1.2-rc.1`，外层记录 submodule 指针变更（独立 commit）。
2. `pnpm sync:upstream` 全量（套 0004 → 构建上游 → pack 受影响包 → 重建 `vendor/dsh-cli` + 新 lock + 指纹）。
3. **configTrees 核对**（新版 `files` 不含 `config/`）：检查 `vendor/dsh-cli/node_modules/@deepseek-ai/dsh/package.json` 的 `dsh.configTrees` 指向；确认所指数据文件在闭包内，缺失则调整 `sync-upstream.ts` 的闭包收集。
4. 核对 `ci:probe-native` 三个 provider（`dsh-subprocess-local`/`dsh-fs-local`/`dsh-attachment-local`）在新闭包中健在；核对 vendor 指纹与 `verify-vendor-lock` 机制不受新 lock 结构影响。

**验收**
- `pnpm sync:upstream` 退出 0；`pnpm ci:verify-vendor-lock` 绿（新锁提交）。
- `pnpm ci:probe-native` 绿（node-pty spawn / koffi load / sharp PNG 三冒烟）。
- `vendor/dsh-cli` 内 `@deepseek-ai/dsh` 版本 = `0.1.2-rc.1`；直接运行 bin.js `dsh web --port 0 --no-open`，stdout 出现带 `?token=` 的 ready 行。
- `pnpm dev` 的校验链第 1/2 步通过（bin.js + 指纹匹配）。

**交付**：commit「chore: bump upstream 到 dsh-v0.1.2-rc.1 并重建 vendor 闭包」。

## 阶段 2：插件机械迁移 + plugin-kit 镜像（0.5–1d）

**任务**
1. 14 个插件 package.json：`@deepseek-ai/dsh-client-runtime` → `@deepseek-ai/dsh-client-store`。
2. `panel-shell`：`panel-store.ts` 的 `createSnapshotStore` import 与 `runtime.d.ts` declare 目标改 `@deepseek-ai/dsh-client-store`。
3. `plugin-kit/src/client-bundle.ts`：`PRELOADED_CLIENT_EXTERNALS` 更新；对照新版 `packages/client/tsdown.client.ts` 镜像 `INLINE_SAFE` 白名单扩增与 `invariant.js` libEntry 移除。
4. **落地待验证项**：`pnpm build && pnpm stage:plugins` 后，检查 staged manifest 在新版 boot（combo 批 / `__DSH_BOOT__.entries[].batches`）下的 entry 分发方式；若 `bundled-plugins.ts` 的 manifest 生成需适配，一并修正。
5. `pnpm typecheck` / `pnpm lint` 清零。

**验收**
- `pnpm build` + `pnpm stage:plugins` 绿，11 个默认插件 staged（`.stage.json` 版本戳 = 0.0.8）。
- `pnpm test -r` 中插件既有单测绿（panel-shell 的 panel-store spec 属此列）。
- `pnpm typecheck`、`pnpm lint` 绿。

**交付**：commit「refactor(plugins): 迁移 dsh-client-runtime → dsh-client-store 并更新 plugin-kit 契约」。

## 阶段 3：宿主 token 适配 + 验收工具适配（1d）→ M1

**任务**
1. `agent-host/ready-line.spec.ts`：补 `?token=` 形态与 LAN 尾巴用例（正则已兼容，锁定行为）。
2. `agent-host/supervisor.ts`：`redactSecrets` 补 `[?&]token=<base64url>` 脱敏模式 + 单测；更新模块头注释（0.1.2 ready 行重新携带 token）。
3. 主进程 `apps/desktop/src/main/agent.ts`/`index.ts`：确认 `loadURL` 使用 ready 行**完整 URL**（若现为 `agentPageUrl(port)` 重构造裸 URL，改为透传 ready.url 含 query）；`security.ts` 导航锁对 token 加载 + 303 重定向的放行做一次实机验证（预期零改动）。
4. **smoke-dsh 适配**（新版 token 鉴权下原判据必挂）：`assertLoopbackReady` 接受带 query 的 ready URL；`validateWebResponse` 改为先 GET token URL（跟随 303 种 cookie）再断言 200 + `#root`；同步更新 `scripts/tests/smoke-dsh.spec.ts`。
5. `smoke-electron.ts` / `smoke-packaged.ts`：核对 ready 抓取与哨兵逻辑对 token 无感（预期零改动，验证即可）。

**验收（M1：无补丁基线恢复）**
- `pnpm --filter @dsh-desktop/agent-host test` 绿。
- `pnpm test:scripts` 绿（smoke-dsh 适配含新用例）。
- `pnpm ci:smoke:dsh` 绿：desktop profile（13 插件装配）启动、127.0.0.1 随机端口、token URL 首载后 200 + `#root`。
- `pnpm ci:smoke:electron` 的 startup 哨兵 `DSH_DESKTOP_READY` 出现（**允许** panel-cluster/titleband 相关断言失败——属阶段 4 恢复项，记录清单）。
- 手工 `DSH_HOME=/tmp/... pnpm dev`：窗口打开、WebUI 可交互、日志无明文 token。

**交付**：commit「feat(desktop): 适配 0.1.2 token 鉴权（agent-host 脱敏 + smoke 判据）」。

## 阶段 4：0006+0004 布局大件 + panel-shell 联调（1.5–2d）→ M2

**任务**（按方案文档 §2.1/§2.2 执行）
1. 重写 0006：新版 `defineStore`/`BoundActions` 骨架上的四列化（columns 四列让位链围绕 `CENTER_MIN=640` + `SIDEBAR_AUTO_COLLAPSE` 重新推导；`SIDEBAR_DEFAULT` 直接写 320 吸收 0004；panel 槽在同一 `register()` children 声明；保留 `--dsh-sidebar-collapsed-track` 缝与四处自修语义）。
2. 0004 在 patches.yml 保留登记，reason 更新（其修改并入 0006 新写法后，0004 退化为空操作或随 0006 合并——实施时二选一并写明）。
3. `patches.yml` 两条 reason 的耦合描述更新；四个上游测试文件（columns/app-frame/layout-store/service）按新版重写断言（含 pin 宽度防回归）。
4. panel-shell 联调：`ctx.panelShell` 服务注册、面板页开合、与 desktop-frame 的 titleband/panel cluster 配合。

**验收（M2：桌面壳恢复）**
- `pnpm sync:upstream` + `pnpm rehearse:queue` 绿（0004+0006 正套/反撤净）。
- `pnpm test:upstream-patches` 绿（0006 携带的 4 个 spec）。
- `pnpm ci:smoke:electron` **startup 哨兵绿**：`data-dsh-panel-cluster` 存在、按钮簇几何断言通过（阶段 3 的失败清单逐项销账）。
- 手工：四列开合、拖拽手柄、放大覆盖层宽度、窄视口（<1024）自动收栏 + panel 让位行为符合预期。

**交付**：commit「feat(patches): 重做 0006 面板列缝适配 0.1.2 ui-slots 骨架（吸收 0004）」。

## 阶段 5：会话流补丁 0005→0008→0009→0007（1.5d）→ M3

**任务**（严格按依赖序，每补丁一 commit，按方案文档 §2.3–§2.6）
1. 0005 活动分组缝迁 `ui-chat`（槽位声明 + chatFlowGrouping 可选服务 + ChatNodeSeat 区间变体）。
2. 0008 inspect 交接：`ChatView.tsx` 的 `openView` 处探测 `panelShell` 委托；同步 `PanelPageOwnerProps` 镜像字段。
3. 0009 openFile 缝：apply 闭包加 `fileBrowser.tryOpen`，保留三重回退。
4. 0007 轨迹面板页：inject 服务名换 `uiSession/uiConversation`，declare 目标改 `dsh-client-ui-conversation/client`。
5. 联调：activity-group 折叠/展开；轨迹面板页 + web 回退；file-browser 从 chat 打开。

**验收（M3：会话流恢复）**
- 每补丁后 `pnpm rehearse:queue` + `pnpm test:upstream-patches` 绿（0005×1、0007×2、0009×1 spec）。
- `pnpm ci:smoke:electron` startup+restart 双哨兵绿。
- 手工：会话中活动分组折叠、Inspect 按钮在面板打开轨迹页并选中目标、chat 内文件点击走 file-browser、无桌面 profile 的 web 形态（`--no-profile` smoke）不回归。

**交付**：4 个 commit（每补丁一个）。

## 阶段 6：agent 链路补丁 0010→0011（0.5–1d）

**任务**（方案文档 §2.7/§2.8）
1. 0010 图片准入缝迁 `packages/api/session-controller/src/commands.ts` 的 `prompt()`；错误码用新版 `RemoteError('session/attachment-invalid')`。
2. 0011 `registerInputTransform` 在 `packages/llm/llm/src/index.ts` 新骨架平移（`TypertRemoteService` 基类、`deepFreeze` 移位、`never.ts` 删除适配）。
3. 联调 vision（需测试用视觉 endpoint 配置）与 web-search 的 `web_search` 工具契约核对（上游 tool 面有重组，实测 `dsh-tool` 注册与辅助模型调用面）。

**验收**
- 两补丁各自 `rehearse:queue` + `test:upstream-patches`（0010×1、0011×1 spec）绿。
- 手工：vision 桥接（配测试 endpoint）图片转写路径触发且原生图片模型不受影响；web-search 结构化来源返回正常。

**交付**：2 个 commit。

## 阶段 7：rewind 链路 0012→0013（决策 A，1.5–2d）→ M4

**任务**（方案文档 §2.9/§2.10）
1. 0012 墓碑 core：`SessionSeq` 品牌类型全量适配；`SessionEventMap` declaration-merge + known-event-types + persistence-catalog 重登记；surface 汇合点折叠解释重放；新增 `rewind.ts` 随补丁落位。
2. 0013 客户端折叠：ingest 三口在 `packages/api/session-controller/src/client/sessions/session.ts` 平移；折叠常量保持本地字面量。
3. **专项测试（新增，进 `packages/plugins/rewind` 测试或脚本层）**：
   - JSONL 持久化 roundtrip：含墓碑会话写→读→surface 折叠一致；
   - 官方 CLI 拒读行为保持（ADR-0007）；
   - 含墓碑会话经上游 `SessionStore.fork` 派生的边界（墓碑在 seed 前界内/外）；
   - rewind 插件 E2E：live + agent 空闲时撤回→回填输入框。
4. ADR-0007 补记：0.1.2 fork 原语的存在与「原地截断」决策理由。

**验收（M4：rewind 恢复）**
- 两补丁 `rehearse:queue` + `test:upstream-patches`（0012×1、0013×1 spec）绿。
- 专项测试四项全绿。
- 手工 E2E：撤回用户消息→上下文回卷→原文回填；重启应用后历史会话含墓碑正常打开（或按 ADR-0007 显式拒读）。

**交付**：2 个 commit + ADR 修订 commit。

## 阶段 8：外围补丁 0001→0014→0015 + 插件联调收尾（1–1.5d）→ M5

**任务**
1. 0001 会话行右键导出：新版 `Menu`/`sessionMenuItems` 结构适配（§2.11），cookie 鉴权下 anchor 下载验证。
2. 0014 settings 图标重放（§2.12）。
3. 0015 重放并合并上游双字节 NUL 修复（§2.13）。
4. 剩余插件逐个联调：review（事件面 `SessionSeq`/新事件类型适配）、file-browser、archive-manager（`setState` 内部面实测 + 501 降级）、model-selection-direct（对照新版 `session/modelCatalog`/`selectModel` Remote 面）。
5. `pnpm ci:probe-electron-sandbox` 验证 0015 面在真实 Electron 宿主的 round-trip。

**验收（M5：功能全量恢复）**
- 全队列 `pnpm rehearse:queue` + `pnpm test:upstream-patches`（10 补丁携带的全部 spec）绿。
- `pnpm ci:probe-electron-sandbox` 绿。
- `pnpm ci:smoke:electron` 双哨兵绿 + 手工核对 review diff/评论回灌、archive 恢复、会话行导出下载。

**交付**：3 个补丁 commit + 插件适配 commit（按插件分组）。

## 阶段 9：全量回归 + 打包（1d）→ M6

**验收（M6：可发布候选）——以下全部绿：**
- `pnpm test` / `pnpm typecheck` / `pnpm lint`
- `pnpm ci:verify-vendor-lock`、`pnpm ci:probe-native`、`pnpm ci:probe-electron-sandbox`
- `pnpm ci:smoke:dsh`、`pnpm ci:smoke:electron`
- `pnpm --filter @dsh-desktop/desktop package:mac` 后 `pnpm ci:smoke:packaged -- --release-dir apps/desktop/release`（tar 含 bin.js + `@dsh-desktop/*`、≤2 万成员、**configTrees 数据在包内**、启动即 ready）
- 三平台 CI 全绿（Windows 重点：WCO 断言、0015、NSIS 产物）
- 闭包体积对比记录（rc.2 vs rc.1，关注 claude-agent-sdk/codex 增量）

**交付**：版本号 bump commit（按项目惯例）。

## 阶段 10：收尾（0.5d）

- `patches/patches.yml` 全部 reason 终稿化（移除迁移期临时注记，注明 0.1.2 适配依据与撤除条件）。
- 文档更新：`docs/architecture.md`（token 鉴权数据流、CSP 注释）、`README.md`（安全模型段：cookie/token、传输描述）、`overlay-titlebar.md` 若 grid 结构描述受 0006 影响。
- 归档迁移记录（本计划文档勾销 + 遗留项清单：combo 待验证结论、web-search 契约偏差、0004 去向）。
- 合入：按全局纪律 4，待 0.1.2 stable 重跑阶段 9 后合 main。

## 风险与回滚对照

| 风险 | 触发阶段 | 缓解/回滚 |
| --- | --- | --- |
| 上游发 rc.2+ 接口再变 | 全程 | 分支不合 main 直至 stable；增量适配按阶段 1 流程重基 |
| configTrees 数据缺漏 → 首启失败 | 1、9 | 阶段 1 核对 + 阶段 9 packaged smoke 兜底 |
| combo 分发改变 staged 插件加载 | 2 | 待验证项在 `stage:plugins` 后立即实测；必要时适配 `bundled-plugins.ts` |
| 0006 让位档位在 `CENTER_MIN=640` 下体验差 | 4 | pin 断言锁行为；档位数值集中定义便于调参 |
| 0012 与 fork/seed 组合边界 | 7 | 专项测试第 3 项覆盖；异常时收缩为「含墓碑会话禁用 fork」守卫 |
| 联调依赖外部凭据（vision/web-search） | 6、8 | 用测试配置；无凭据时标记「联调待补」不阻塞 M5/M6 门槛之外的手工项 |
