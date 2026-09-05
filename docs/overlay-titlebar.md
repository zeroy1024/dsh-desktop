# 窗口与标题栏

桌面窗框由 Electron 宿主和 `desktop-frame` 客户端插件协作实现。插件通过 `shell.overlay`
叠加标题带，并消费登记补丁提供的布局接缝；不复制上游 AppFrame 或会话树。
进程和分发架构见[架构总览](architecture.md)，以下说明当前平台行为与维护要点。

## 平台宿主

| 平台 | WebUI 宿主 | 窗框与材质 |
| --- | --- | --- |
| Windows | BrowserWindow 的 primary webContents | hidden + Window Controls Overlay；满足条件时 Mica，否则 solid |
| macOS | BaseWindow 内的 WebContentsView | hiddenInset、原生红绿灯与 vibrancy |
| Linux | BaseWindow 内的 WebContentsView | hidden，无系统材质，使用实底 |

Windows 的 WCO 几何只在 primary webContents 可用；曾使用 child view 导致 rect 为零、
按钮与 caption 区重叠，因此不能直接统一成 macOS/Linux 的宿主结构。
Windows splash 为全不透明的顶层 child view，WebUI 在下方预加载；macOS splash 保留透明材质。
agent 重启前先铺 splash，避免旧页与空白导航闪现。资源所有权由
[`splash.ts`](../apps/desktop/src/main/splash.ts) 管理。

## 标题带、侧栏与面板

- 标题带与会话 header 对齐为 44px。空会话隐藏 header 时，titleband 检测后铺满窗口；
  标记缺失时保守回落侧栏宽度。交互控件设置 `no-drag`，其余顶带用于拖动窗口。
- 侧栏隐藏顶部品牌与原折叠钮，宽态新会话使用树行样式；折叠/新会话等按钮进入标题带。
  新会话、项目、会话、设置与搜索结果对齐同一行高和间距；选择器按 role 定位新版树行。
- 侧栏默认 320px，折叠到 0px 的变量接缝与四列面板布局由
  [0006](../patches/0006-ui-layout-panel-seam.patch) 承担；原 0004 默认宽度补丁已合并。
- Windows caption 安全区从 `env(titlebar-area-*)` 与 WCO rect 推导；标题带左侧按钮簇的
  让位由 ResizeObserver 实测并写入 `--dsh-titleband-content-end`，不复用 macOS 灯区常量。
- 轨迹的创建接口由 0007 提供，页面装配与接管属于 panel-shell；聊天 Inspect 通过 0008 交接。
  会话行 ZIP 导出与快速归档属于 [session-actions](../packages/plugins/session-actions/README.md)。

## 菜单与外观

Windows 的主进程持有 File/Edit/View/Window 菜单模板，保留 roles 和快捷键，隐藏原生菜单栏。
插件绘制顶级菜单标签；renderer 只传菜单 id 与锚点矩形，主进程按缩放换算并约束坐标后弹出
原生 submenu。macOS 使用 app/edit 最小原生菜单，Linux 清空 application menu。
实现见 [`application-menu.ts`](../apps/desktop/src/main/application-menu.ts)。

Mica 在 Windows 11 build ≥ 22000 且未启用 forced colors/减少透明度时启用，否则回落实底。
WebUI 主题经 preload 同步到 nativeTheme，caption glyph 与材质跟随深浅主题。
侧栏和 titleband 使用半透明 wash，中栏、详情及工作面板保持实底；forced colors 使用系统语义色。
实现见 [`windows-appearance.ts`](../apps/desktop/src/main/windows-appearance.ts)。

## 升级与验收

1. 核对上游侧栏/header DOM、role、data 属性和主题变量；CSS 覆盖依赖这些结构。
2. 检查折叠/展开、空会话、窄窗、面板开关与缩放；按钮不能与系统 caption 相交。
3. 检查拖拽区域、按钮点击和菜单快捷键，避免 `drag` 吞掉交互。
4. 检查深浅主题、透明效果关闭与高对比度；Windows 的 DWM 材质、Snap Layout 和 caption
   外观需要真机复核，CI 几何断言不能替代视觉验收。
5. 运行相关单测和 [Electron/打包冒烟](ci.md)。Windows smoke 检查 WCO 非零、inset、
   caption 避让、菜单和 appearance 标记；runner 无法验证最大化时保留初始几何检查并报告限制。

既往字号、侧栏与工具栏回归的复现和验证边界见 [UI 一致性历史记录](history/ui-native-consistency-audit.md)。
