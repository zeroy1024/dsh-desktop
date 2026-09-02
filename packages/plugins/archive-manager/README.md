# @dsh-desktop/archive-manager

归档管理内置插件：在 dsh 设置面板注册「归档管理」页，查看归档会话并一键恢复（unarchive）。
背景与决策见 [docs/adr/0005-archive-manager-plugin.md](../../../docs/adr/0005-archive-manager-plugin.md)。

## 双半结构

- **node 半**（`src/index.ts`）：把 `POST /dsh-desktop/archive-manager/unarchive` 经
  `ctx.webServer.register()` 挂进 dsh 自带的 web 服务（同源访问）。恢复调用
  `WorkspaceRegistry` 运行时存在的 private `setState`，走官方链路完成内存态、
  `~/.dsh/storages/workspace.json` 持久化与 `host/archived-sessions-changed` 广播，
  侧边栏因此实时刷新。handler 做方法 / 同源（Origin↔Host）/ 载荷三重校验；上游重构
  内部面时返回 501，客户端降级为只读列表。
- **client 半**（`src/client/`）：注册 `settings.section`（id `archive-manager`），
  数据读 slot 渲染器注入的 `useWorkspaces` / `useSessions` 座位；写走同源 fetch。
  成功后不手动改 store——事件回推让行自然消失。

## 边界

- 不做删除：上游无会话删除 API，插件删文件会留下 registry 死槽位（ADR-0005）。
- as-any `setState` 是"越过类型使用"而非修改上游：submodule bump 时若
  `WorkspaceRegistry` 的 `state` / `setState` 面变更，路由自动 501 降级，不损坏数据。
