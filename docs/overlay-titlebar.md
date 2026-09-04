# 方案：原生标题栏与侧栏融为一体

- 状态：v2 已实施（Windows 窗框 + WCO）；折叠 0 宽由 `patches/0006-ui-layout-panel-seam.patch`（原 0002 变量缝已并入）+ desktop-frame 覆盖 `--dsh-sidebar-collapsed-track`；会话 view tab 已由 desktop-frame 藏掉（0007 后 conversation.view 只剩 chat 一项，上游 tablist 本就不再渲染，CSS 规则转为兜底；轨迹 view 经 0007/0008 迁入右侧面板页，chat 的 Inspect 按钮走 panelShell 交接）；会话 header 上下 padding 清零、titleRow 撑 44px，标题垂直居中且与侧栏顶带同线（水平布局维持官方左对齐）；中栏 header 整行并入窗口拖动带（交互元素 no-drag 挖洞）；blank 态 header 隐藏时 titleband 检测后自动铺满整窗，拖动带常驻（标记缺失时保守回落侧栏宽）；折叠态中栏 header 让位与分隔线位置由 `--dsh-titleband-content-end`（Titleband 实测左簇右缘）推导；官方 Session log 下载胶囊已迁至会话行右键菜单（patch 0001 菜单项 + 同源 anchor 下载，插件 CSS 按 `data-slot` 锚藏起 header.utilities 槽）；侧栏默认宽 320 由 patch 0004 承担
- 日期：2026-09-04
- 参照：`/Users/zeroy/Projects/dsh-desktop`（Tauri 桌面壳）运行时预览

## Windows 窗框（v2，2026-09）

Windows 从「系统标题栏 + Electron 默认菜单栏」迁到 Codex 风格单行窗框（方案
见下「三条路」后的平台分流说明）：

- **窗口宿主**：Windows 改用 `BrowserWindow`，`titleBarStyle:'hidden'` +
  `titleBarOverlay:{color:'#00000000', height:44}`，dsh WebUI 直接加载在
  primary webContents——`navigator.windowControlsOverlay` 只有 primary 能拿到
  非零 rect，正是 0.0.3/0.0.4 叠键回归的根因（BaseWindow + WebContentsView
  恒为 0）。macOS/Linux 保持 `BaseWindow` + child view 不变。
- **启动层**：Windows splash 视图全不透明（primary 在下方预加载不穿透），
  macOS 保持透明透 vibrancy；重启 agent 时先铺 splash 再停旧 agent，杜绝
  旧页/`about:blank` 闪现（详见 `apps/desktop/src/main/splash.ts`）。
- **应用菜单**：主进程固定模板（File/Edit/View/Window，全部 Electron roles）
  安装为 application menu 保留 accelerator，原生菜单栏 `setMenuBarVisibility
  (false)`；自绘 `文件/编辑/视图/窗口` 顶级标签（desktop-frame
  ApplicationMenuBar，zh/en）弹出的是同一份 submenu——renderer 只传 menu id
  + anchor 矩形，坐标按 `webContents.getZoomFactor()` 换算成窗口 DIP 并
  clamp（`apps/desktop/src/main/application-menu.ts`）。
- **外观**：Mica 只在 Windows 11（build ≥ 22000）且非 forced colors / 非减少
  透明度时启用，其余明确 solid 实底（`apps/desktop/src/main/windows-appearance.ts`）；
  WebUI 主题偏好经 preload 驱动 `nativeTheme.themeSource`，caption glyph 与
  Mica 跟随页面主题。侧栏/titleband 透 Mica（90% wash），center/details/
  panel 保持实底；forced colors 下走系统语义色。
- **几何**：caption 区让位全部由 `env(titlebar-area-*)` 推导
  （`--dsh-titlebar-x/width/height`、左右 inset），代码中不存在固定 caption
  宽度；折叠态左簇让位由 `--dsh-titleband-content-end`（ResizeObserver 实测）
  推导，Windows/Linux 不再落入 darwin 假灯区（172/168/159.5 三份常量已删除）。
- **smoke**：Windows CI/打包 smoke 断言 WCO rect 非零、左右 inset 与视口宽
  吻合、panel cluster 不与 caption 区相交、菜单栏已渲染且原生菜单栏隐藏、
  appearance dataset 与主进程一致；最大化/恢复复查在 runner 上不可用时降级
  为告警（保留初始几何断言）。

## 已知问题（2026-09 审查记录）

- **折叠态几何按 darwin 调优**：已随 v2 修复——折叠态 header padding 与
  分隔线改从 `--dsh-titleband-content-end`（实测左簇右缘）推导，win/linux
  不再有约 100px 假灯区。darwin 实测值 160px 与旧 168/176 观感一致。
- **Windows Mica/像素效果需真机验收**：CI 只能证明几何契约；DWM 材质、
  Snap Layout、深浅切换的 caption glyph、关闭透明效果/高对比度下的回退
  仍按发布门槛在实机矩阵人工验证（见 README 发布检查单）。

目标视觉（用户截图）：去掉侧栏顶部 logo；折叠按钮与红绿灯同一行；「新会话」从胶囊按钮改成会话树同款整行 item；侧栏走 macOS 高斯模糊（Windows 走系统 Mica）。本文记录已落地方案与维护边界。

## 1. 参照项目实际改了什么

截图不是「把红绿灯叠上去」这么简单。Tauri 项目把官方 webui 的布局源码改成了桌面专用壳：

| 观感 | 落点 | 官方 rc.2 现状 |
| --- | --- | --- |
| `titleBarStyle: Overlay`，红绿灯浮在内容上 | `tauri.conf.json` | macOS 已是 `hiddenInset`；Windows v2 起 `hidden` + WCO（WebUI 在 BrowserWindow primary）；Linux 仍 `hidden` |
| 44px 单行 titleband；折叠钮紧挨红绿灯（leading 92px） | `ui-layout` 新增 `shell.toolbar` 槽 + `AppFrame` 绝对定位工具条 | **没有 `shell.toolbar`**；`AppFrame` 只有三列 + `shell.overlay` |
| 侧栏折叠到 **0 宽**（不是 56px 轨道） | `ui-layout` 的 grid / 折叠语义 | 折叠 = 固定 **56px rail**（`columns.ts` `SIDEBAR_COLLAPSED`） |
| 去掉侧栏品牌 | 从 `SidebarRoot` 拿掉 logo 行；`ui-brand-official` 只填会话英雄位 | `SidebarRoot` 顶部 `logoRow`：品牌（点了等于新会话）+ 折叠钮 |
| 新会话改成树行 | `SidebarRoot.module.css` `.newSession` 34px / radius 8 / 透明底 hover | 胶囊按钮（描边、居中） |
| 侧栏 vibrancy | 窗材质 `sidebar`；`.frame` 透明；`.sidebarCol` 90% wash；中栏/详情实底 | 侧栏 `var(--dsw-specific-sidebar-fill)` 实底；我们的 webui 视图还是不透明白 |
| 顶栏拖窗口 / 双击最大化 | AppKit 监视器 + iframe `postMessage` 交互矩形桥 + CSS hit-test 洞 | Electron 有 `-webkit-app-region`，**不需要这套** |

参照项目的拖拽栈（`window_drag.rs`、`desktopTitleband.ts`、跨源 `dsh_host_origin`）是 Tauri「壳页 + iframe、主文档吃不到子文档点击」逼出来的。我们窗口自身就是 webui，再抄会把简单问题做复杂，且和边界铁律相反。

结论：参照的视觉 = **上游布局源码级改造**，不是插件。直接 port 等于在 `patches/` 里长期维护一整份 ui-layout / ui-sidebar fork。

## 2. 约束

1. `upstream/` 不直接改；能插件就不 patch（AGENTS.md、ADR-0004）。
2. `packages/plugins/` 的 desktop profile 与客户端插件通道已经落地；本提案必须继续沿用该通道。
3. 启动层按平台分流：Windows 是 BrowserWindow primary WebUI + 不透明 splash child view；macOS/Linux 仍是 BaseWindow + 双 child view。侧栏要透出材质，揭幕后的 webui 不能整幅不透明白底。
4. 官方扩展点里，真正能「换掉整列」的是占据 `sidebar` 槽（注释写明 OCCUPIED，再 register 即替换，且必须自己声明 `sidebar.workspaces` 等子槽）。`shell.overlay` 是唯一现成的**加性**框级槽。

## 3. 三条路

### A. 只改 Electron：`titleBarStyle: 'hiddenInset'`

红绿灯浮到内容上，系统标题栏消失。**立刻能做，也立刻是错的**：官方 logo 行顶在 (0,0)，灯会压在品牌和折叠钮上。未给侧栏留出 44px 带之前不要开。

拖拽用 Electron 自己的能力即可：

- `hiddenInset` 保留原生灯；
- 可点控件 `-webkit-app-region: no-drag`，其余顶带 `drag`；
- `trafficLightPosition` 微调垂直居中。

不要移植 AppKit monitor / 矩形桥。

### B. 客户端插件 `desktop-frame`（推荐主路径，已落地）

插件做「桌面窗框」，不换 AppFrame，不 fork 会话树：

1. **宿主打标**：preload 已有 `window.dshDesktop`。插件 `apply` 里写 `html[data-dsh-desktop]`（及 platform），CSS 用属性选择器，和参照同一套门控。
2. **样式叠层**（插件自带 CSS Modules / 注入全局样式）：
   - 藏 `.logoRow` 里的品牌（`sidebar.brand.*` 仍注册，只是不画；英雄位品牌不动）；
   - 侧栏 `padding-top` 让出 titleband（约 44px，灯 + 折叠钮一行）；
   - `.newSession` 改成与会话行同轴的整行 item（高、圆角、透明、hover 填充对齐 `ui-workspace`）；
   - `.sidebarCol` / `.root` 背景改成半透明 wash，`.centerCol` / `.detailsCol` 保持实底。
3. **折叠钮（及折叠态新会话）进灯行**：官方没有 `shell.toolbar`，用现成的 `shell.overlay` 挂两个绝对定位按钮（约 `left: 92px`，高 44px 垂直居中），CSS 藏侧栏里原来的 toggle。宽态新会话仍留在列内整行；折叠态 overlay 再给一个图标孪生（参照也是这么拆的）。
4. **Electron 配套**（插件能画、壳必须配合）：
   - 同时打开 `hiddenInset`；
   - 揭幕后 webui 视图 `setBackgroundColor('#00000000')`，否则侧栏 CSS 再透明也透不出 vibrancy；
   - 窗材质建议 `vibrancy: 'sidebar'`（侧栏列）或维持 `under-window`（整窗桌面模糊，侧栏 wash 负责可读性）——实现时对着实机二选一，Linux 无材质，插件 CSS 回落实底（参照已有 `data-dsh-platform='linux'` 分支）。

做不到、也不该在 v1 用插件硬做的：

- 折叠到 **0 宽**：`columns.ts` 仍是 56px rail；桌面通过 `--dsh-sidebar-collapsed-track: 0px` 覆盖主布局 track。overlay 折叠钮在灯右侧。
- 会话 view tab：已由插件 CSS 藏掉（`center-col` 内 `header [role='tablist']`）。0007 把 trajectory 迁为右侧面板页后 conversation.view 只剩 chat，上游 `tabs.length > 1` 才渲染 tablist，该规则转为防未来 view 的兜底；Inspect 手势经 0008 缝走 panelShell 交接打开轨迹页。
- 会话顶栏并进 44px titleband：header 几何在 `ui-conversation`，上游无稳定 DOM 属性与变量缝，纯插件只能结构选择器硬覆盖（不可靠）。走 0006 同款「变量缝」patch（变量化 header 几何 + 稳定 data 属性，默认值=官方现值），插件消费变量。未实施。

代价：CSS 选择器绑官方 class / DOM（`logoRow`、`newSession`）。上游改 class 要跟。比维护一份 layout fork 轻得多，也符合「UI 走客户端插件」。

### C. `patches/` 提供插件无法获得的最小布局缝

当前修改 `AppFrame` 的是 `0006-ui-layout-panel-seam.patch`（原 0002 的折叠轨变量缝已并入其中）：折叠默认仍回落官方 56px rail，桌面插件可用 CSS 变量把实际 track 设为 0。不修改 store、`SIDEBAR_COLLAPSED` 或 SidebarRoot，也不引入完整 layout fork。

`sync-upstream.ts` 会自动 pack 并 override 所有登记补丁触及的 workspace package，确保运行时 CLI 使用本地补丁包，而不是重新从 registry 安装官方版本。

**不要**为了拖拽去 patch。那是 Electron 的本职。

还有一条「占整个 `sidebar` 槽、插件里重写 SidebarRoot」：能换掉 logo / 新会话 DOM，但要复刻子槽声明和行为，等于 fork 一个包。比 CSS 叠层重，比源码 patch 稍干净。v1 不取；若 CSS 选择器在一次上游大改后崩了，再升到占槽。

## 4. 平台分流后的推荐切法（Windows 与 macOS/Linux 不同）

2026-09（v2）起，窗口宿主按平台分流（详见本文件开头「Windows 窗框」一节）：

```
Windows（BrowserWindow + WCO）
    │  titleBarStyle:'hidden' + titleBarOverlay{透明, 44}
    │  primary webContents 直挂 WebUI；splash 是 contentView 顶层 child view
    │  appearance 控制器：Mica / solid 回退 / nativeTheme 跟随
    │  主进程 application menu（roles/accelerator）+ setMenuBarVisibility(false)
    └─ desktop-frame：
         html[data-dsh-desktop][data-dsh-platform='win32'] + CSS
         WCO env(titlebar-area-*) 推导左右安全区
         ApplicationMenuBar 顶级标签 + --dsh-titleband-content-end 实测让位
         Mica wash / solid 实底 / forced-colors 系统色三层回退
         Linux 实底回落（linux 无系统材质）；macOS 走 92px 灯区 + vibrancy wash

macOS / Linux（维持原路径）
    BaseWindow + child view；macOS hiddenInset + vibrancy，Linux hidden 无 overlay
```

**不要**单独先合 `hiddenInset`。灯和 logo 重叠比「独立标题栏」更糟。Electron 与插件同一里程碑上（v1 已合；v2 的 Windows 分流是同一插件通道的另一平台分支）。

和现有 splash 的关系：macOS 启动层继续用 vibrancy + 透明 splash 视图；Windows 的 splash 视图全不透明，primary WebUI 在其下预加载（揭幕后 primary 留在原位，不再有 child view 可见性切换）。

## 5. 风险

- **选择器漂移**：插件 CSS 依赖官方模块 class。升级 checklist 加一条「侧栏顶栏 DOM」。
- **overlay 对不齐**：darwin 灯区仍按 `trafficLightPosition`（16px）调；Windows 不再猜灯（WCO env 推导），左簇让位用 ResizeObserver 实测（`--dsh-titleband-content-end`）。升级上游时检查 WCO env/`windowControlsOverlay` 契约是否变化。
- **拖拽误伤**：顶带 `drag` 会吞按钮点击，折叠 / 新会话 / 菜单栏必须 `no-drag`。不要学参照去扫 DOM 报矩形。
- **暗色主题**：Windows 的 caption glyph/Mica 由 `nativeTheme.themeSource`（WebUI 主题偏好驱动）跟随；`body[data-ds-dark-theme]` wash 与 solid 回退分别按 dataset 分支。主题切换若出现「材质亮、wash 暗」先查 appearance 控制器广播链。
- **插件构建契约漂移**：`plugin-kit` 已支持 CSS Modules/全局 CSS 注入；升级上游时仍须对照 `tsdown.client.ts` 验证 ModuleLoader 与样式契约。desktop-frame 的 `dsh.client.inject` 新增 locale/ui-theme 依赖，两者都是上游 web profile 既有插件，未引入新外部面。

## 6. 验收（落地时）

- 无独立系统标题栏；红绿灯叠在侧栏顶带，不挡住折叠钮与新会话。
- 侧栏无 DeepSeek / HARNESS logo；英雄区品牌仍在。
- 宽态「新会话」是整行 item，不是胶囊。
- 侧栏能看到桌面模糊（或 90% wash 后的模糊）；中栏不透墙纸。
- 顶带空白处拖窗口、双击缩放；按钮可点。
- `pnpm typecheck` / `pnpm lint` / 根与上游聚焦测试保持绿；`upstream/` 工作树只包含 `patches.yml` 登记补丁。
