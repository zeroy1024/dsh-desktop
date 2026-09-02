# ADR-0005：归档管理插件 —— webServer 注册路由 + registry 运行时 setState

- 状态：已接受
- 日期：2026-09-03

## 背景

上游 dsh 侧边栏的会话归档是单向操作：归档仅向 workspace 域 global state 的
`archivedSessionIds` 追加会话 ID（`upstream/packages/workspace/workspace/src/index.ts:244`），
会话日志与 `sessionIds` 槽位原样保留，但存在三个缺口——无归档列表视图、无恢复（unarchive）
API、无删除会话 API。上游 README 明文承认（`upstream/packages/client/ui-workspace/README.md:34`），
源码注释将 unarchive 标注为 "a future unarchive"。

归档集合的落点：本机 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`（JSON
后端，内存态权威、整文件原子重写）。运行中直接改文件会被下一次写覆盖，且同样不解决查看入口。

## 选项

- **A. 等上游实现 `workspace.unarchiveSession` RPC**：最干净，但时间不可控，期间用户只能手改
  JSON 文件。否决为唯一路径。
- **B. host 半插件裸起私有 HTTP 端口**（独立 `node:http` server + CORS + 端口协商）：可行但
  要自行解决端口发现、CORS、与 dsh web 服务的信任重复。重且丑。
- **C. patches/*.patch 给上游加 unarchive RPC**：违反最小干预；归档恢复不是上游缺失的基础
  能力，而是其明确规划中的功能，不值得为此背 patch 维护成本。
- **D. 插件双半：client 半注册 `settings.section` 页 + host 半经 `ctx.webServer.register()`
  挂同源路由 + 运行时调用 `WorkspaceRegistry` 的 private setState（选定）**。

## 决定

采用 D，落地为 `packages/plugins/archive-manager`：

1. **client 半**注册 `settings.section`（id `archive-manager`）——官方公开插槽，设置壳注释明言
   "adding a setting never means editing the shell"。数据读走 slot 渲染器注入的
   `useWorkspaces`/`useSessions` 座位（`archivedSessionIds`、会话 `displayTitle`、工作区归属）。
2. **host 半**用上游规范的 `ctx.webServer.register()` 把 `POST /dsh-desktop/archive-manager/unarchive`
   挂进 dsh 自带的 web 服务（desktop profile 必含 `dsh-web-app` → webServer 必然可用）。
   同源访问，无需 CORS/端口协商；handler 内做方法、同源（Origin 对 Host）、载荷三重校验。
3. **unarchive 实现**：调用 `WorkspaceRegistry` 运行时存在的 private `setState`——TS `private`
  仅存在于编译期，运行时方法真实可见。走 registry 官方链路意味着内存态、`workspace.json`
   持久化、`domain/changed` → `host/archived-sessions-changed` 广播一次完成；客户端 store
   自动消化该事件，侧边栏实时恢复显示，插件不手动改任何 store。调用点以插件内 promise 链
   互斥，弥补绕过 `enqueueOperation` 串行链的并发空隙。
4. **不做删除**：上游连数据面都没有删除 API；插件删文件会在 registry 表留下死槽位。真删除
   等上游提供会话移除 API（届时 patch 或上游 PR）。
5. **退化路径**：host 半运行时探测 `state`/`setState` 内部面，缺失（上游重构）时路由返回 501，
   client 半降级为只读列表并提示。这是"越过类型使用"的显式代价，记入后果。

## 后果

- 零 patch、零上游源码改动；上游自行实现 unarchive RPC 后，host 半路由与 as-any 调用可整体
  退役，client 半数据通路不变。
- as-any 依赖的是运行时事实而非类型承诺：submodule bump 时须检查 `WorkspaceRegistry` 的
  `state`/`setState` 是否仍存在（列入升级 checklist；探测失败即 501，不会损坏数据）。
- 路由仅挂在 dsh 的 loopback web 服务上，与官方 RPC 同信任级别；同源校验拒绝跨源与 DNS
  rebinding 形态的伪造请求。
- 恢复操作绕过 `enqueueOperation` 串行链：与用户并发点「归档」存在理论上的写交错窗口，靠
  插件内互斥 + 人工低频操作兜底。registry 的 `validateStoredState` 仍会兜住不一致并 fail loud。
