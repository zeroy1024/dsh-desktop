# @dsh-desktop/session-actions

会话行的桌面操作客户端插件：在原生菜单中增加「导出会话日志」，在非空会话行的悬停区域增加快速归档。重命名、分叉与菜单归档继续使用原生实现。

`patches/0001` 只提供通用 `sessionRowActions` 贡献接口与行级渲染点。此插件负责图标、双语文案和回调，卸载时移除贡献。

导出使用原生同源 `/api/session.export`，带上 `sessionId` 与 `includeDescendants=true`，保留 `dsh-session-<id>.zip` 文件名。归档调用行宿主提供的 `archive()`，与原生菜单共享同一操作和状态更新。

客户端类型引用 vendor 中的公开 `SessionRowActionFactory`，不导入上游源码。`tests/actions.spec.ts` 检查注册释放、归档委托和 ZIP 导出参数。
