# ADR-0002：MVP 传输 —— HTTP 内嵌；真 IPC 暂缓

- 状态：已接受
- 日期：2026-08-29

## 背景

上游 WebUI 与 Agent 之间是「fetch(Request) 形状」的协议，HTTP 只是载体之一。上游在 `packages/host/webserver/src/index.ts` 明确预留了 Electron 接缝：*"Electron uses file:// plus IPC instead"*，但该路径**有设计、无实现**。

## 选项

- **A. `dsh web` 子进程 + `loadURL`**：复用上游现成的 HTTP/SSE/WS 服务，零上游改动，今天就能跑通全功能。代价：渲染进程直连 127.0.0.1 端口。
- **B. 直接实现 IPC 桥**：符合官方最终方向，但 fetch-over-IPC 含 SSE/WS 流桥接，工作量大且未验证，会拖住 MVP。
- **C. 自定义协议 `dsh://` + 主进程 `net.fetch` 代理**：token/端口不出现在渲染 URL，底下仍是 HTTP。曾作为 P3 落地。

## 决定

MVP 用 A（`--no-open --port 0`，AgentSupervisor 解析 ready 行）。真 IPC（B）等上游 webserver 有实现再做。

> 更新（2026-08-29）：专用 `desktop` profile 的组装提前到 P2（内置插件分发的载体，见 ADR-0004）。
>
> 更新（2026-08-30）：P3 曾落地 C（`dsh://127.0.0.1` + `net.fetch` 代理，WS 经 IPC）。随后证实：抄浏览器 `Host` + 流式 passthrough 会让模块脚本 `net::ERR_FAILED`，页面停在空 `#root`；自定义协议还要永久承担 Chromium 代理表面。C 买到的隔离（token 不进 URL）配不上成本——上游当前 ready 行已无 launch token，鉴权是 Host/Origin fence；即便 XSS 也仍能 `fetch('/api')`。P3 的自定义协议已撤销，回到 A：`loadURL(http://127.0.0.1:<port>/)`，导航锁死这一代端口，token 不进文档 URL、不进 preload。

## 当前鉴权（0.1.2-rc.1 修订）

上述 2026-08-30 的 Host/Origin-only 描述属于历史状态。当前首载使用 ready URL 的一次性
token 换取签名 Cookie，再导航至干净 URL；重启时仅清理旧端口鉴权 Cookie。
传输仍为 loopback HTTP，完整数据流见[架构总览](../architecture.md#数据流)。

## 后果

- 端口只绑 127.0.0.1（上游禁止 `--host 0.0.0.0`）。
- 渲染进程看得到端口，这和「本机已有一个 loopback HTTP」是同一档事实。
- 迁 B 时再引入 `file://` / 自定义协议 + `__DSH_TRANSPORT__`，preload API 保持最小桌面能力，不提前养一条 HTTP 代理。
