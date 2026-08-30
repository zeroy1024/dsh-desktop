/**
 * splash.ts — 启动层控制器。
 *
 * Electron 的正确模型是 BaseWindow + 两个 WebContentsView（不是窗口自身
 * loadURL 再盖一层 overlay）：
 *
 *   桌面 → 窗口 vibrancy（高斯模糊）→ [webui 视图，揭幕前不可见]
 *                                → splash 视图（透明底 + 淡 tint + 鲸鱼）
 *
 * 启动层必须半透明才能透出桌面模糊；因此 webui 绝不能出现在 splash 底下的
 * 合成栈里——哪怕用 CSS 隐藏也不行（子节点 `visibility: visible` 会穿透，
 * 上游 WorkspaceBrowser 的「工作区」标签就是这样漏出来的）。揭幕前
 * `webuiView.setVisible(false)`，视图不参与合成，JS 照常跑、挂载检测照常
 * 工作。揭幕后摘除 splash，窗口只剩 webui 视图。
 *
 * 视图 bounds 相对窗口内容区，原点恒为 (0, 0)；不能用 getContentBounds()
 * （那是屏幕坐标，会把视图偏移到窗外）。
 */
import { app, WebContentsView, type BaseWindow } from 'electron'
import { join } from 'node:path'

export type SplashPhase = 'starting' | 'loading' | 'sealed' | 'revealed' | 'error'

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

export interface SplashController {
  /** 创建顶层 splash 视图并加载本地启动页，首帧就绪后显示窗口。 */
  attachSplash: () => Promise<void>
  /**
   * 创建底层 webui 视图。visible=false 时视图不参与合成（加载/挂载仍进行），
   * 半透明 splash 底下只剩 vibrancy，才能透到桌面。
   */
  attachWebui: (opts: { visible: boolean }) => WebContentsView
  /**
   * 轮询 webui 是否完成应用挂载（boot 页消失且 #root 有子树）。
   * @returns true=挂载确认；false=超时或视图已销毁，调用方决定是否强制揭幕。
   */
  waitForMount: (view: WebContentsView, timeoutMs: number) => Promise<boolean>
  /** 推送启动百分比（0-100）。 */
  sendProgress: (percent: number) => void
  /** 推送阶段迁移；error 阶段附带可读原因。 */
  sendPhase: (phase: SplashPhase, message?: string) => void
  /** 揭幕：webui 可见、splash 淡出后摘除，焦点交给 webui。 */
  reveal: () => Promise<void>
  /** 摘除两个视图并注销 resize 监听；重复调用安全。 */
  dispose: () => void
}

export function createSplashController(win: BaseWindow): SplashController {
  let splashView: WebContentsView | null = null
  let webuiView: WebContentsView | null = null

  const contentBounds = (): { x: number; y: number; width: number; height: number } => {
    const [width, height] = win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  const syncBounds = (): void => {
    const bounds = contentBounds()
    splashView?.setBounds(bounds)
    webuiView?.setBounds(bounds)
  }
  win.on('resize', syncBounds)

  const sendPhase = (phase: SplashPhase, message?: string): void => {
    if (splashView !== null && !splashView.webContents.isDestroyed()) {
      splashView.webContents.send('dsh-splash:phase', phase, message)
    }
  }

  const removeView = (view: WebContentsView): void => {
    if (!win.isDestroyed() && win.contentView.children.includes(view)) {
      win.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  return {
    async attachSplash() {
      splashView = new WebContentsView({
        webPreferences: {
          preload: dist('splash-preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      // 透明背景：让窗口 vibrancy 材质透出，成为启动层的模糊氛围
      splashView.setBackgroundColor('#00000000')
      win.contentView.addChildView(splashView)
      syncBounds()
      await splashView.webContents.loadFile(dist('splash.html'))
      win.show()
    },

    attachWebui({ visible }) {
      webuiView = new WebContentsView({
        webPreferences: {
          preload: dist('preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // unpackaged 时注入 --dsh-dev，preload 据此打开 FPS HUD 等 dev 能力
          additionalArguments: app.isPackaged ? [] : ['--dsh-dev'],
        },
      })
      // 不透明兜底：揭幕后盖住 vibrancy，与日常窗口白底一致
      webuiView.setBackgroundColor('#ffffff')
      // index 0：压在 splash 之下
      win.contentView.addChildView(webuiView, 0)
      webuiView.setVisible(visible)
      syncBounds()
      // 已在树中的 splash 再 add 一次会重排到最顶，避免 webui 抢到 z-order
      if (splashView !== null) win.contentView.addChildView(splashView)
      return webuiView
    },

    async waitForMount(view, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (view.webContents.isDestroyed()) return false
        try {
          // boot 页挂出时 #root 带 data-dsh-boot 标记；应用挂载后标记消失且 #root 有子树
          const mounted: unknown = await view.webContents.executeJavaScript(
            "document.querySelector('[data-dsh-boot]') === null && (document.querySelector('#root')?.children.length ?? 0) > 0",
          )
          if (mounted === true) return true
        } catch {
          // 文档卸载中等瞬态：下一轮再试
        }
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
      webuiView?.setVisible(true)
      sendPhase('revealed')
      await delay(REVEAL_FADE_MS + 60)
      if (splashView !== null) {
        removeView(splashView)
        splashView = null
      }
      webuiView?.webContents.focus()
    },

    dispose() {
      win.off('resize', syncBounds)
      if (splashView !== null) {
        removeView(splashView)
        splashView = null
      }
      if (webuiView !== null) {
        removeView(webuiView)
        webuiView = null
      }
    },
  }
}
