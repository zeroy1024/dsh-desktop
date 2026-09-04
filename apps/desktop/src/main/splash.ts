/**
 * splash.ts — 启动层控制器。
 *
 * 平台分层：Windows 的 BrowserWindow 自带 primary webContents，WebUI 直接
 * 加载在其中；splash 是 contentView 顶层的独立 WebContentsView，只借用
 * primary，不接管它的生命周期。macOS/Linux 继续使用 BaseWindow，并由本
 * 控制器拥有一个 WebUI child view 与 splash child view。
 *
 * 启动层在 macOS 上保持透明以透出窗口 vibrancy；其他平台由 splash 页面
 * 自己铺实底。揭幕前 WebUI 不参与合成（Windows 的 primary 只是在 splash
 * 下预加载），揭幕后摘除 splash 并把焦点交给 primary/child WebUI。
 *
 * 视图 bounds 相对窗口内容区，原点恒为 (0, 0)；不能用 getContentBounds()
 * （那是屏幕坐标，会把视图偏移到窗外）。
 */
import { app, WebContentsView, type BaseWindow, type WebContents } from 'electron'
import { join } from 'node:path'

export type SplashPhase = 'starting' | 'loading' | 'sealed' | 'revealed' | 'error'

/**
 * splash 视图底色。Windows 的 BrowserWindow primary 在启动页下方预加载，
 * 半透明底会漏出它（以及无 Mica 支持时的窗口底色），必须全不透明；
 * macOS 的 splash 依靠窗口 vibrancy 提供模糊氛围，保持透明。
 * @param platform - 主进程 `process.platform`。
 * @returns WebContentsView 可接受的 CSS 背景色。
 */
export function splashBackgroundColor(platform: string): string {
  return platform === 'win32' ? '#f8f8fa' : '#00000000'
}

/** WebUI 资源：Windows 借用窗口 primary，其他平台拥有 child view。 */
export type WebuiResource =
  | { ownership: 'borrowed'; contents: WebContents; view: null }
  | { ownership: 'owned'; contents: WebContents; view: WebContentsView }

/** 定格总时长：水位推满 1.2s，字标延迟淡入与之重叠；须覆盖 splash.css 的字标动画。 */
export const SEAL_TOTAL_MS = 1250
/** 遮罩淡出时长，与 splash.css 中 #splash 的 opacity transition 时长一致。 */
export const REVEAL_FADE_MS = 550
/** 挂载检测超时：超时强制揭幕并告警，避免用户卡在启动层。 */
export const MOUNT_TIMEOUT_MS = 20000
/** 挂载轮询间隔。 */
const MOUNT_POLL_MS = 250

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const dist = (file: string): string => join(import.meta.dirname, file)

/** 与 Windows primary 和 macOS/Linux child view 共用的 WebUI preload 配置。 */
export function createWebuiWebPreferences() {
  return {
    preload: dist('preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // unpackaged 时注入 --dsh-dev，preload 据此打开 FPS HUD 等 dev 能力
    additionalArguments: app.isPackaged ? [] : ['--dsh-dev'],
  }
}

/** 释放由 splash 拥有的 child view；borrowed primary 永远不触碰。 */
export function releaseWebuiResource(win: BaseWindow, resource: WebuiResource | null): void {
  if (resource === null || resource.ownership === 'borrowed') return
  const { view } = resource
  if (!win.isDestroyed() && win.contentView.children.includes(view)) {
    win.contentView.removeChildView(view)
  }
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

export interface SplashController {
  /** 创建顶层 splash 视图并加载本地启动页，首帧就绪后显示窗口。 */
  attachSplash: () => Promise<void>
  /**
   * 获取 WebUI 资源。传入 primary 时只借用 BrowserWindow 的 WebContents；
   * 未传入时创建并拥有一个 WebContentsView。visible=false 只对 owned child
   * 生效，borrowed primary 始终由 BrowserWindow 管理可见性。
   */
  attachWebui: (opts: { visible: boolean }) => WebuiResource
  /**
   * 轮询 WebUI 是否完成应用挂载（boot 页消失且 #root 有子树）。
   * @returns true=挂载确认；false=超时或 WebContents 已销毁，调用方决定是否强制揭幕。
   */
  waitForMount: (contents: WebContents, timeoutMs: number) => Promise<boolean>
  /** 推送启动百分比（0-100）。 */
  sendProgress: (percent: number) => void
  /** 推送阶段迁移；error 阶段附带可读原因。 */
  sendPhase: (phase: SplashPhase, message?: string) => void
  /** 揭幕：owned child 变可见、splash 淡出后摘除，焦点交给 WebUI。 */
  reveal: () => Promise<void>
  /** 摘除 splash、释放 owned child，并注销 resize 监听；重复调用安全。 */
  dispose: () => void
}

export interface SplashControllerOptions {
  /** Windows BrowserWindow 的 primary WebContents；由控制器借用但不拥有。 */
  primary?: WebContents
  /** 测试注入：覆盖 process.platform（splash 底色分支用）。 */
  platform?: string
  /** 测试注入：替换 WebContentsView 构造（真实路径默认 new WebContentsView）。 */
  createView?: (kind: 'splash' | 'webui') => WebContentsView
}

export function createSplashController(
  win: BaseWindow,
  options: SplashControllerOptions = {},
): SplashController {
  const platform = options.platform ?? process.platform
  const createView = options.createView ?? ((kind: 'splash' | 'webui'): WebContentsView => {
    const webPreferences = kind === 'splash'
      ? {
          preload: dist('splash-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        }
      : createWebuiWebPreferences()
    return new WebContentsView({ webPreferences })
  })
  let splashView: WebContentsView | null = null
  let webuiResource: WebuiResource | null = null
  const borrowedPrimary = options.primary ?? null

  const contentBounds = (): { x: number; y: number; width: number; height: number } => {
    const [width, height] = win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  const syncBounds = (): void => {
    const bounds = contentBounds()
    splashView?.setBounds(bounds)
    if (webuiResource?.ownership === 'owned') webuiResource.view.setBounds(bounds)
  }
  win.on('resize', syncBounds)

  const sendPhase = (phase: SplashPhase, message?: string): void => {
    if (splashView !== null && !splashView.webContents.isDestroyed()) {
      splashView.webContents.send('dsh-splash:phase', phase, message)
    }
  }

  const removeSplashView = (view: WebContentsView): void => {
    if (!win.isDestroyed() && win.contentView.children.includes(view)) {
      win.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  return {
    async attachSplash() {
      splashView = createView('splash')
      // macOS 依靠窗口 vibrancy 透出桌面；Windows 必须是不透明层，避免
      // primary WebContents 在启动页下方预加载时漏出半透明缝隙。
      splashView.setBackgroundColor(splashBackgroundColor(platform))
      win.contentView.addChildView(splashView)
      syncBounds()
      await splashView.webContents.loadFile(dist('splash.html'))
      win.show()
    },

    attachWebui({ visible }) {
      if (webuiResource !== null) {
        releaseWebuiResource(win, webuiResource)
        webuiResource = null
      }
      if (borrowedPrimary !== null) {
        // BrowserWindow 的 primary 由窗口自身管理；这里仅返回借用句柄，
        // 不调用 setVisible/setBounds，也不在 dispose 时 close。
        webuiResource = { ownership: 'borrowed', contents: borrowedPrimary, view: null }
        return webuiResource
      }

      const view = createView('webui')
      // 透明：侧栏 CSS wash 才能透出窗口 vibrancy；中栏由页面铺实底
      view.setBackgroundColor('#00000000')
      // index 0：压在 splash 之下
      win.contentView.addChildView(view, 0)
      view.setVisible(visible)
      webuiResource = { ownership: 'owned', contents: view.webContents, view }
      syncBounds()
      // 已在树中的 splash 再 add 一次会重排到最顶，避免 webui 抢到 z-order
      if (splashView !== null) win.contentView.addChildView(splashView)
      return webuiResource
    },

    async waitForMount(contents, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (contents.isDestroyed()) return false
        const slice = Math.min(MOUNT_POLL_MS, Math.max(0, deadline - Date.now()))
        try {
          // boot 页挂出时 #root 带 data-dsh-boot 标记；应用挂载后标记消失且 #root 有子树。
          // 必须和超时竞速：渲染进程主线程卡住时 executeJavaScript 永不返回。
          const mounted: unknown = await Promise.race([
            contents.executeJavaScript(
              "document.querySelector('[data-dsh-boot]') === null && (document.querySelector('#root')?.children.length ?? 0) > 0",
            ),
            delay(slice).then(() => 'poll' as const),
          ])
          if (mounted === true) return true
        } catch {
          // 文档卸载中等瞬态：下一轮再试
        }
        if (Date.now() >= deadline) break
        await delay(MOUNT_POLL_MS)
      }
      return false
    },

    sendProgress(percent) {
      if (splashView !== null && !splashView.webContents.isDestroyed()) {
        splashView.webContents.send('dsh-splash:progress', percent)
      }
    },

    sendPhase,

    async reveal() {
      if (webuiResource?.ownership === 'owned') webuiResource.view.setVisible(true)
      sendPhase('revealed')
      await delay(REVEAL_FADE_MS + 60)
      if (splashView !== null) {
        removeSplashView(splashView)
        splashView = null
      }
      if (webuiResource !== null && !webuiResource.contents.isDestroyed()) {
        webuiResource.contents.focus()
      }
    },

    dispose() {
      win.off('resize', syncBounds)
      if (splashView !== null) {
        removeSplashView(splashView)
        splashView = null
      }
      releaseWebuiResource(win, webuiResource)
      webuiResource = null
    },
  }
}
