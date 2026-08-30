# ADR-0002：MVP 传输 —— HTTP 内嵌；P3 迁 file:// + IPC 桥

- 状态：已接受
- 日期：2026-08-29

## 背景

上游 WebUI 与 Agent 之间是「fetch(Request) 形状」的协议，HTTP 只是载体之一。上游在 `packages/host/webserver/src/index.ts` 明确预留了 Electron 接缝：*"Electron uses file:// plus IPC instead"*，但该路径**有设计、无实现**。

## 选项

- **A. `dsh web` 子进程 + `loadURL`**：复用上游现成的 HTTP/SSE/WS 服务与 token 认证，零上游改动，今天就能跑通全功能。代价：多一个 127.0.0.1 端口与 token 交换面。
- **B. 直接实现 IPC 桥**：符合官方最终方向，但 fetch-over-IPC 含 SSE/WS 流桥接，工作量大且未验证，会拖住 MVP。

## 决定

MVP 用 A（`--no-open --port 0`，AgentSupervisor 解析 ready 行）；P3 再做 B：`packages/bridge` 实现 fetch-over-IPC（流用 MessagePort 逐消息桥），webui 以 `file://`（或自定义协议）加载，并组装专用 `desktop` profile（cordis.patch.yml 配置叠层，不动源码）。

> 更新（2026-08-29）：专用 `desktop` profile 的组装提前到 P2（内置插件分发的载体，见 ADR-0004）；P3 只剩 file:// 加载 + IPC 桥本身。
>
> 更新（2026-08-30）：P3 落地为自定义协议 `dsh://127.0.0.1`（等价于官方说的 file://，且避开 file:// CORS）+ 主进程 `net.fetch` 代理 agent HTTP；`/api/events.*` WebSocket 经 IPC。agent 子进程仍听 127.0.0.1（上游 webserver 无 IPC 实现），但 token 与端口不出渲染进程。官方 `__DSH_TRANSPORT__` 未用——页面继续走 WebApiClient，fetch 走同 origin 的 dsh://，WS 被注入垫片替换。

## 后果

- 阶段 A 的端口只绑 127.0.0.1（上游禁止 `--host 0.0.0.0`），token 不出主进程。
- 迁 B 时 Electron 层对渲染侧暴露的 preload API 保持不变，webui 无感。
