# @dsh-desktop/archive-manager

归档管理内置插件：在 dsh 设置面板注册「归档管理」页，查看归档会话（含归档时间
与最后活跃时间，支持排序与工作区分组）并一键恢复（unarchive）。
背景与决策见 [docs/adr/0005-archive-manager-plugin.md](../../../docs/adr/0005-archive-manager-plugin.md)。

## 双半结构

- **node 半**（`src/index.ts`）：把 `POST /dsh-desktop/archive-manager/unarchive` 经
  `ctx.webServer.register()` 挂进 dsh 自带的 web 服务（同源访问）。恢复调用
  `WorkspaceRegistry` 运行时存在的 private `setState`，走官方链路完成内存态、
  `~/.dsh/storages/workspace.json` 持久化与 `host/archived-sessions-changed` 广播，
  侧边栏因此实时刷新。handler 做方法 / 同源（Origin↔Host）/ 载荷三重校验；上游重构
  内部面时返回 501，客户端降级为只读列表。
- **时间侧车**（`src/timestamps.ts`）：上游 `archivedSessionIds` 只有 ID、无时间戳，
  归档时间由本插件自记——监听 `domain/changed`（workspace 域 global 写入携带完整
  快照），把归档集合与自有 `archive_timestamps` 域（storage-domain 表，
  message-feedback 同款 sidecar 模式）reconcile：新 ID 记 now、消失 ID 删行，
  幂等且容忍事件乱序；启动时以 registry 当前集合 seed。`POST
  /dsh-desktop/archive-manager/timestamps`（POST 而非 GET：浏览器同源 GET 不带
  Origin 头，判定面与 unarchive 同构）把快照暴露给客户端。
- **client 半**（`src/client/`）：注册 `settings.section`（id `archive-manager`），
  数据读 slot 渲染器注入的 `useWorkspaces` / `useSessions` 座位 + 进页拉一次时间
  侧车；每行 meta 显示「归档 · 最后活跃」，工具条支持按归档时间/最后活跃时间
  升降序排序与按工作区分组切换（组内排序跟随所选字段，缺时间戳的行垫底）。
  写走同源 fetch；成功后不手动改 store——事件回推让行自然消失。

## 边界

- 不做删除：上游无会话删除 API，插件删文件会留下 registry 死槽位（ADR-0005）。
- as-any `setState` 是"越过类型使用"而非修改上游：submodule bump 时若
  `WorkspaceRegistry` 的 `state` / `setState` 面变更，路由自动 501 降级，不损坏数据。
- 归档时间只覆盖插件装载后发生的归档；更早的历史归档无时间戳，行内省略该字段。
- 设置导航的归档图标来自补丁 `patches/0014-settings-nav-archive-icon.patch`
  （上游 navIcon 按 section id 硬编码，图标面插件不可达）。
