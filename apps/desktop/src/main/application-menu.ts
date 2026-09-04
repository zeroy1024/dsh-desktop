/**
 * application-menu.ts — 主进程拥有的应用菜单（仅 win32 装配）。
 *
 * 结构：固定模板 + Electron roles，主进程安装为 application menu 以注册
 * accelerator（Ctrl+C/V/A 等），但原生菜单栏强制不可见（setMenuBarVisibility
 * false + autoHide false），禁止 Alt 再弹出第二条系统菜单栏。渲染进程只画
 * 顶级标签（desktop-frame 的 ApplicationMenuBar），弹出时只传 menu id +
 * anchor 矩形；本模块校验闭合 id、按 zoom 把 CSS px 换算成窗口 DIP、
 * clamp 到内容区，然后调用对应 submenu 的 Menu.popup。
 *
 * 同一时刻只允许一个 popup：切换菜单先 closePopup 前一个，避免多 popup
 * 竞态；popup 关闭（callback）后通知渲染进程取消 active 高亮。
 */
import {
  Menu,
  app,
  type BaseWindow,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebFrameMain,
} from 'electron'

export const APPLICATION_MENU_IDS = ['file', 'edit', 'view', 'window'] as const
export type ApplicationMenuId = (typeof APPLICATION_MENU_IDS)[number]

export function isApplicationMenuId(value: unknown): value is ApplicationMenuId {
  return typeof value === 'string' && (APPLICATION_MENU_IDS as readonly string[]).includes(value)
}

/**
 * 固定菜单模板：顶层标签不用 `&` mnemonic（那会让 Alt+F 触发原生菜单栏
 * 激活），键盘菜单交互由渲染进程的 ApplicationMenuBar 拥有；菜单项全部
 * 走 Electron roles 以保留系统快捷键与 focused-frame 行为。dev-only 项按
 * 现有开发语义控制（unpackaged/dev 态才挂 reload/devtools）。
 */
export function buildApplicationMenuTemplate(isDev: boolean): MenuItemConstructorOptions[] {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    ...(isDev
      ? [
          { role: 'reload' as const },
          { role: 'forceReload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
        ]
      : []),
    { role: 'resetZoom' as const },
    { role: 'zoomIn' as const },
    { role: 'zoomOut' as const },
    { type: 'separator' as const },
    { role: 'togglefullscreen' as const },
  ]
  return [
    { label: 'File', submenu: [{ role: 'quit' as const }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { type: 'separator' as const },
        { role: 'close' as const },
      ],
    },
  ]
}

/** renderer 传来的 anchor 矩形（页面 CSS px）。 */
export interface PopupAnchor {
  x: number
  y: number
  width: number
  height: number
}

/** 校验闭合形状：全部有限、非负；拒绝 NaN/Infinity/负数。 */
export function isValidPopupAnchor(anchor: unknown): anchor is PopupAnchor {
  if (typeof anchor !== 'object' || anchor === null) return false
  const value = anchor as Record<string, unknown>
  return typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0
    && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0
    && typeof value.width === 'number' && Number.isFinite(value.width) && value.width >= 0
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height >= 0
}

export interface PopupPoint {
  x: number
  y: number
}

/**
 * 把页面 CSS px 的 anchor 换算成窗口 DIP 弹出点：x 用 anchor 左缘、
 * y 用 anchor 底缘（菜单从标签下方展开）。页面 zoom 放大后一个 CSS px
 * 覆盖更多窗口 DIP，因此应乘以 zoomFactor，再 round 并 clamp 进内容区；
 * zoomFactor 异常（<=0）时按 1 处理。
 */
export function popupPointFor(
  anchor: PopupAnchor,
  zoomFactor: number,
  content: [number, number],
): PopupPoint {
  const zoom = zoomFactor > 0 && Number.isFinite(zoomFactor) ? zoomFactor : 1
  const x = Math.min(Math.max(0, Math.round(anchor.x * zoom)), Math.max(0, content[0] - 1))
  const y = Math.min(Math.max(0, Math.round((anchor.y + anchor.height) * zoom)), Math.max(0, content[1] - 1))
  return { x, y }
}

/** Electron Menu 的测试面（真实对象是 Menu.buildFromTemplate 产物）。 */
export interface MenuLike {
  popup(options: {
    window?: BaseWindow
    frame?: WebFrameMain
    x?: number
    y?: number
    callback?: () => void
  }): void
  closePopup(): void
}

/** 把 Electron 的 number[] 收窄成坐标元组（getContentSize 恒返两项）。 */
function getContentSizeTuple(size: number[]): [number, number] {
  const width = size[0] ?? 0
  const height = size[1] ?? 0
  return [width, height]
}

/** popup 依赖注入：menu 按 id 查询 + 真实 popup/closePopup 实现。 */
export interface MenuPopupDeps {
  menuById: (id: ApplicationMenuId) => MenuLike | null
  closePopup: (menu: MenuLike) => void
}

/** 单 popup 互斥控制器：切换前关掉前一个；关闭回调按 generation 归因。 */
export class ApplicationMenuPopupController {
  #deps: MenuPopupDeps
  #openMenu: MenuLike | null = null
  #generation = 0

  constructor(deps: MenuPopupDeps) {
    this.#deps = deps
  }

  /** 是否有 popup 正在打开。 */
  isOpen(): boolean {
    return this.#openMenu !== null
  }

  /**
   * 弹出指定顶级菜单。id 越界/anchor 非法/无对应菜单返回 false 且不弹出。
   * 新 generation 在关闭旧 popup 前生效，因此旧回调（包括同一 menu 对象的
   * 快速重开）不会清掉新 popup 的状态。
   * @param onClosed - 当前 generation 的 popup 关闭回调。
   */
  show(
    id: ApplicationMenuId,
    win: BaseWindow,
    contents: WebContents,
    anchor: PopupAnchor,
    onClosed: (closedId: ApplicationMenuId) => void,
  ): boolean {
    if (!isApplicationMenuId(id) || !isValidPopupAnchor(anchor)) return false
    const menu = this.#deps.menuById(id)
    if (menu === null) return false
    const generation = ++this.#generation
    if (this.#openMenu !== null) {
      this.#deps.closePopup(this.#openMenu)
      this.#openMenu = null
    }
    const point = popupPointFor(anchor, contents.getZoomFactor(), getContentSizeTuple(win.getContentSize()))
    this.#openMenu = menu
    menu.popup({
      window: win,
      frame: contents.focusedFrame ?? contents.mainFrame,
      x: point.x,
      y: point.y,
      callback: () => {
        if (generation !== this.#generation) return
        this.#openMenu = null
        onClosed(id)
      },
    })
    return true
  }
}

interface InstalledMenuState {
  controller: ApplicationMenuPopupController
  menus: Record<ApplicationMenuId, Menu>
  barHidden: boolean
}

let installed: InstalledMenuState | null = null

export interface ApplicationMenuState {
  /** application menu 已安装（accelerator 已注册）。 */
  installed: boolean
  /** 原生菜单栏已被强制隐藏（Alt 不会再弹出）。 */
  barHidden: boolean
}

/** CI smoke 用：主进程侧的菜单安装状态。 */
export function applicationMenuState(): ApplicationMenuState {
  return { installed: installed !== null, barHidden: installed?.barHidden ?? false }
}

/**
 * 安装应用菜单并隐藏原生菜单栏（仅 Windows 调用）。菜单栏不可见但
 * accelerator 与 roles 依然生效；自绘顶级标签弹的是这些 submenu。
 * 重复调用（窗口重建）只重应用当前窗口的菜单栏可见性，菜单本体只装一次。
 */
export function installApplicationMenu(win: BaseWindow): void {
  if (installed === null) {
    const template = buildApplicationMenuTemplate(!app.isPackaged)
    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
    const menus = {
      file: menu.items[0].submenu,
      edit: menu.items[1].submenu,
      view: menu.items[2].submenu,
      window: menu.items[3].submenu,
    } as unknown as Record<ApplicationMenuId, Menu>
    installed = {
      controller: new ApplicationMenuPopupController({
        menuById: (id) => menus[id] ?? null,
        closePopup: (menuLike) => { menuLike.closePopup() },
      }),
      menus,
      barHidden: true,
    }
  }
  // menu 是 application-level（Menu.setApplicationMenu），窗口级状态仍需
  // 每窗口重设：autoHide=false + visibility=false 后 Alt 不会再唤出原生栏。
  win.setAutoHideMenuBar(false)
  win.setMenuBarVisibility(false)
  installed.barHidden = !win.isMenuBarAutoHide() && !win.isMenuBarVisible()
}

export interface PopupApplicationMenuOptions {
  win: BaseWindow
  contents: WebContents
  id: ApplicationMenuId
  anchor: PopupAnchor
  /** popup 关闭通知（渲染进程取消 active 高亮）。 */
  onClosed: (closedId: ApplicationMenuId) => void
}

/**
 * 弹出已安装的顶级菜单；未安装/非法入参时静默返回 false。
 * 坐标按 contents 的 zoomFactor 换算并 clamp 进窗口内容区。
 */
export function popupApplicationMenu(options: PopupApplicationMenuOptions): boolean {
  if (installed === null) return false
  const { win, contents, id, anchor, onClosed } = options
  return installed.controller.show(id, win, contents, anchor, onClosed)
}