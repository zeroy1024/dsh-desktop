# @dsh-desktop/fps-overlay

开发态右下角 FPS HUD，用于观察工作台动画是否掉帧。仅在 preload 暴露
`window.dshDesktop.dev === true` 时注册和渲染；打包应用不显示。

## 实现与测量范围

- 客户端在 `shell.overlay` 注册不接收指针事件的徽章，node 半为空实现，无上游补丁。
- `requestAnimationFrame` 采样，使用 500ms 窗口平均帧率，每 150ms 更新数字。
- 以近期帧间隔中位数估算刷新周期，超过两倍周期判为掉帧，闪红 250ms；兼容 60/120Hz。
- 页面隐藏时不计样本，可见性变化清空窗口并显示 `—`；卸载取消 rAF 并清理监听器。

读数反映当前 WebUI 页面 rAF 回调节奏，会受窗口可见性与调度影响；它不能测量整机 GPU、
Electron 主进程或独立 splash 视图的帧率，也不提供刷新率解锁或原生限帧控制。
`hello-panel` 默认禁用，不与 HUD 争用右下角。

## 开发验证

在仓库根目录运行：

```bash
pnpm --filter @dsh-desktop/fps-overlay test
pnpm --filter @dsh-desktop/fps-overlay build
pnpm stage:plugins
```

采样计算测试在 `tests/fps.spec.ts`；通过 `pnpm dev` 检查显示、掉帧提示及隐藏/恢复行为。
