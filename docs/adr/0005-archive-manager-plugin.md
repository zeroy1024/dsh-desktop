# ADR-0005：归档管理插件与公开取消归档 API

- 状态：已接受；2026-09-05 修订，替代运行时访问私有 setState 的临时实现。
- 初始日期：2026-09-03

## 背景

上游归档只向 WorkspaceRegistry 的 `archivedSessionIds` 添加会话 ID，保留日志和
会话在工作区中的位置。桌面需要查看归档列表及恢复会话，但 0.1.2-rc.1 没有公开
取消归档 API。直接写 `storageDomain` 或 JSON 文件不能同步 registry 的内存状态，
后续写入还可能覆盖它；调用私有 state/setState/enqueueOperation 依赖内部实现。

## 决定

保留双半 archive-manager 插件，使用最小补丁 0016 公开
`WorkspaceRegistry.unarchiveSession(SessionId): Promise<boolean>`：

1. 客户端经公开 `settings.section` 注册归档页，从原生 workspace/session 数据源
   读取归档集合、标题与工作区归属。
2. Host 经 `webServer.register()` 挂同源恢复路由，复用 `connection.requestRejection`
   鉴权及插件生命周期；方法、Origin 与请求体继续由路由校验。
3. 插件只调用公开 `unarchiveSession`，不读取内部 state，也不自行修改存储。
   方法在 registry 原有队列中读取最新状态，持久化成功后发布内存状态和变更广播；
   返回 false 表示本来未归档，重复恢复幂等。
4. Registry 卸载先拒绝新操作，等待已接纳的写入完成，再关闭存储。
5. 公共 API 缺席时路由返回 501，客户端保留只读列表。类型从 vendor 正式包导入，
   构建会直接暴露上游契约变化。

## 权衡与验证

零补丁需要依赖私有成员，或复制并替代整套 WorkspaceRegistry。一个与 archiveSession
对称的方法更小，也使队列、持久化和广播继续由同一 owner 负责；插件保留列表、路由、
鉴权、图标与交互，不给上游新增桌面 RPC 或页面。上游提供等价 API 后撤销 0016。

真实 Cordis/storage 回归覆盖重复恢复、归档与恢复交错、写入失败后重试、卸载排空及
重启后状态一致；HTTP 测试覆盖鉴权、错误映射、幂等和路由卸载。

会话永久删除仍需独立的上游移除契约，不以删日志文件代替。
