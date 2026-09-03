# 方案：帧率显示插件

- 状态：已实施（dev HUD）
- 日期：2026-08-30

产品定义（已确认）：**实时帧率 HUD**，用来肉眼看后续动画有没有掉帧。不是参照项目那种写日志、切 cap 的探针。

结论：客户端插件即可，P2 通道已经够用。

## 1. 两件不同的事

参照 Tauri 项目 `apps/desktop/src/fpsProbe.ts` 做的不是产品 HUD，是 **WKWebView 合成器诊断**：

- rAF 采样帧间隔，每 2s 打一行 `fps / p50 / p95 / jank`
- `auto` 模式会调原生 `set_fps_cap`（WebKit 私有 API）做 ABA 对比
- 挂在**壳页**上，测的是 WKWebView 的 vsync，不是 React 树

我们要的是 HUD：屏幕上一直有数字，动画一卡就能看见从 60 掉到 40/20。和探针只重合「用 rAF 数间隔」这一小段。解锁刷新率上限不在范围里。

## 2. 难度

| 目标 | 落点 | 难度 |
| --- | --- | --- |
| 角落显示约 60 / 30 的数字 | `packages/plugins/fps-overlay`，`shell.overlay` + `requestAnimationFrame` | **低**。hello-panel 同款：空 node 半、client 半注册 overlay、profile 自动扫目录物化 |
| 显示 p95 / jank 次数 | 同上，多十几行统计 | 低 |
| 只在 dev / 快捷键开关 | 插件读 `dshDesktop` 或 `localStorage`；可选 preload 加一个 flag | 低 |
| 测 Electron 窗口铬 / 独立 splash 视图的帧率 | 要在对应 `WebContents` 里跑 rAF，插件够不到 splash | 中，且产品用不上 |
| 解锁 60fps cap（参照 `fps_unlock.rs`） | Chromium/Electron 私有或 `webPreferences`，不是 dsh 插件 | **高**，且和 HUD 无关 |

HUD 的测量含义要说清楚：页面 rAF 反映的是 **Chromium 对该 webContents 的合成节奏**（可见、前台时通常跟显示器刷新走），不是 GPU 整机帧率，也不是主进程。窗口最小化 / `visibilityState=hidden` 时 rAF 会停，数字应显示 stalled，不要当成卡死。

## 3. 推荐做法（实施时）

照 hello-panel 再做一个内置插件，不要改 Electron 壳、不要 patch 上游。

1. `packages/plugins/fps-overlay/`
   - node 半：空 `apply`
   - `dsh.bundle.patch` 自激活 insert
   - `dsh.client`：`platform: web`，`inject` runtime + ui-layout（等 `shell.overlay` 声明）
2. client：`shell.overlay` 挂一个 `position:absolute; right/bottom` 的徽章（`pointer-events: none`）
   - rAF 记 `performance.now()` 间隔
   - **不要**每帧显示 `1000/dt`（噪声太大，60Hz 会在 55–70 乱跳，看不出动画掉帧）
   - 用约 **500ms 滑动窗口**：`fps = 1000 * n / sum(dt)`，每 100–200ms 刷新数字，观感是「实时」但稳
   - 用近期有效帧间隔的中位数估算刷新周期，单帧 `dt > 2 × refreshInterval` 记一次掉帧：60Hz 阈值约 33ms，120Hz 阈值约 16.7ms。这样高刷屏不会沿用错误的 60Hz 基线
   - `document.hidden` 事件立即停表并显示 `—`；恢复可见时清空旧窗口，避免把后台暂停算成卡顿
3. 物化：`resolveBundledPlugins()` 扫描 staged 后的 CLI 闭包 `vendor/dsh-cli/node_modules/@dsh-desktop`（`apps/desktop/src/main/bundled-plugins.ts:21-47`；打包态为首启解压出的副本），不用改 profile；`package.json` 声明 `dshDesktop.enabled: false` 的插件保留在仓库但默认不装配；`pnpm dev` 已构建全部 `packages/plugins/*`
4. 默认 **dev 开、打包关**（`dshDesktop.dev` 或构建 `define`）。正式版不常驻。

不要做：

- 不要在主进程 / splash 视图再插一套探针（和用户看到的 UI 不是同一条渲染管线）
- 不要移植 `set_fps_cap` / 私有 WebKit API
- 不要占 `root` 槽、不要改 AppFrame

## 4. 和 hello-panel 的关系

hello-panel 已经占了右下角。FPS 徽章要么叠在它上方（`order` 更大、`bottom` 再抬一截），要么落地时把 hello-panel 当成验收件删掉/挪开。两块都 `shell.overlay` list 槽，不冲突。

## 5. 工作量（实施时）

大约一个 hello-panel 的量：插件包 + 滑动窗口 FPS + 掉帧闪一下。单测覆盖 `fpsFromDeltas`、刷新周期中位数和 60/120Hz 卡顿阈值，不必上 Electron。零 patch；壳只通过 preload 暴露只读的 `dshDesktop.dev`。
