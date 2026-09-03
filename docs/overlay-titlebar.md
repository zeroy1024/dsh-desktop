# 方案：原生标题栏与侧栏融为一体

- 状态：v1 已实施；折叠 0 宽由 `patches/0006-ui-layout-panel-seam.patch`（原 0002 变量缝已并入）+ desktop-frame 覆盖 `--dsh-sidebar-collapsed-track`；会话 view tab 已由 desktop-frame 藏掉（0007 后 conversation.view 只剩 chat 一项，上游 tablist 本就不再渲染，CSS 规则转为兜底；轨迹 view 经 0007/0008 迁入右侧面板页，chat 的 Inspect 按钮走 panelShell 交接）；会话 header 上下 padding 清零、titleRow 撑 44px，标题垂直居中且与侧栏顶带同线（水平布局维持官方左对齐）；中栏 header 整行并入窗口拖动带（交互元素 no-drag 挖洞，details 列头部待 --dsh-titleband-indent 变量缝补丁（编号未定）加锚点后跟进）；blank 态 header 隐藏时 titleband 检测后自动铺满整窗，拖动带常驻（标记缺失时保守回落侧栏宽）；折叠态中栏 header 让位 `padding-left: 168px`（与 padding 同曲线动画；1px 分隔线按视觉锚点光学居中于 + 图标右缘 144 与标题字形左缘 176 之间（159.5），仅折叠态淡入，参照项目 data-titleband-divider 同款；待 --dsh-titleband-indent 变量缝补丁（编号未定）落地后收编）；官方 Session log 下载胶囊已迁至会话行右键菜单（patch 0001 菜单项 + 同源 anchor 下载，插件 CSS 按 `data-slot` 锚藏起 header.utilities 槽）；侧栏默认宽 320 由 patch 0004 承担（layout 服务面不暴露宽度写入，插件不可达）
- 日期：2026-08-30
- 参照：`/Users/zeroy/Projects/dsh-desktop`（Tauri 桌面壳）运行时预览

## 已知问题（2026-09 审查记录）

**折叠态几何按 darwin 调优**：`FOLDED_CLUSTER_PX = 172`（`packages/plugins/desktop-frame/src/geometry.ts:8`）、折叠态 header `padding-left: 168px` 与分隔线 `left: 159.5px`（`src/client/chrome.css` 折叠态规则）都是含红绿灯区（trafficLightPosition x:16）的 **darwin 值**。win/linux 无原生红绿灯（titleband 按钮实为 12px 起排），折叠态存在约 100px 的视觉冗余（假灯区）。修正需要 win/linux 真机视觉验证——几何常量（`FOLDED_CLUSTER_PX`）、padding、分隔线位置三处需配套改；在拿到真机前不在盲改。

目标视觉（用户截图）：去掉侧栏顶部 logo；折叠按钮与红绿灯同一行；「新会话」从胶囊按钮改成会话树同款整行 item；侧栏走 macOS 高斯模糊。本文记录已落地方案与维护边界。

## 1. 参照项目实际改了什么

截图不是「把红绿灯叠上去」这么简单。Tauri 项目把官方 webui 的布局源码改成了桌面专用壳：

| 观感 | 落点 | 官方 rc.2 现状 |
| --- | --- | --- |
| `titleBarStyle: Overlay`，红绿灯浮在内容上 | `tauri.conf.json` | 我们现在是系统标题栏，内容在铬下方，所以「那一栏是独立的」 |
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
3. 启动层已经用 `BaseWindow` + 双 `WebContentsView`；侧栏要透出桌面模糊，揭幕后的 webui 视图不能继续整幅不透明白底。
4. 官方扩展点里，真正能「换掉整列」的是占据 `sidebar` 槽（注释写明 OCCUPIED，再 register 即替换，且必须自己声明 `sidebar.workspaces` 等子槽）。`shell.overlay` 是唯一现成的**加性**框级槽。

## 3. 三条路

### A. 只改 Electron：`titleBarStyle: 'hiddenInset'`

红绿灯浮到内容上，系统标题栏消失。**立刻能做，也立刻是错的**：官方 logo 行顶在 (0,0)，灯会压在品牌和折叠钮上。未给侧栏留出 44px 带之前不要开。

拖拽用 Electron 自己的能力即可：

- `hiddenInset` 保留原生灯；
- 可点控件 `-webkit-app-region: no-drag`，其余顶带 `drag`；
- `trafficLightPosition` 微调垂直居中。

不要移植 AppKit monitor / 矩形桥。

### B. 客户端插件 `desktop-frame`（推荐主路径）

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

## 4. 推荐切法

```
客户端插件通道（已就绪）
    │
    ├─ Electron：hiddenInset + trafficLightPosition
    │            揭幕后 webui 视图透明底（splash 揭幕逻辑要改 setBackgroundColor）
    │            顶带 -webkit-app-region: drag / 控件 no-drag
    │
    └─ 插件 desktop-frame：
         html[data-dsh-desktop] + CSS（藏品牌、titleband 留白、新会话整行、侧栏 wash、藏会话 tab）
         shell.overlay 挂灯行折叠钮（折叠态再挂新会话图标）
         Linux 实底回落
    │
    └─ 折叠 0 宽：最小补丁覆盖 collapsed track；会话 header 并入 titleband、AppKit 拖拽桥仍不做
```

**不要**单独先合 `hiddenInset`。灯和 logo 重叠比「独立标题栏」更糟。Electron 与插件同一里程碑上。

和现有 splash 的关系：启动层继续用 vibrancy + 透明 splash 视图。揭幕后若 webui 整幅不透明，侧栏模糊不存在；改为视图透明、由页面中栏自己铺实底。这是壳层一行，不是上游 patch。

## 5. 风险

- **选择器漂移**：插件 CSS 依赖官方模块 class。升级 checklist 加一条「侧栏顶栏 DOM」。
- **overlay 对不齐**：灯的系统 inset 随 `hiddenInset` / `trafficLightPosition` 变。92px leading 要按实机校准，写成插件 CSS 变量，不要写死进主进程。
- **拖拽误伤**：顶带 `drag` 会吞按钮点击，折叠 / 新会话必须 `no-drag`。不要学参照去扫 DOM 报矩形。
- **暗色主题**：wash 要跟 `body[data-ds-dark-theme]`（参照已有）。主题切换时 vibrancy 是否跟 appearance 走，实现时用 `nativeTheme` 钉一下，避免材质亮、wash 暗。
- **插件构建契约漂移**：`plugin-kit` 已支持 CSS Modules/全局 CSS 注入；升级上游时仍须对照 `tsdown.client.ts` 验证 ModuleLoader 与样式契约。

## 6. 验收（落地时）

- 无独立系统标题栏；红绿灯叠在侧栏顶带，不挡住折叠钮与新会话。
- 侧栏无 DeepSeek / HARNESS logo；英雄区品牌仍在。
- 宽态「新会话」是整行 item，不是胶囊。
- 侧栏能看到桌面模糊（或 90% wash 后的模糊）；中栏不透墙纸。
- 顶带空白处拖窗口、双击缩放；按钮可点。
- `pnpm typecheck` / `pnpm lint` / 根与上游聚焦测试保持绿；`upstream/` 工作树只包含 `patches.yml` 登记补丁。
