import { describe, expect, it, vi } from 'vitest'
import type { BaseWindow, WebContents, WebContentsView } from 'electron'
import { createSplashController, releaseWebuiResource, splashBackgroundColor } from '../src/main/splash'

/** 结构 Fake：真实路径的 electron 对象在 node 测试下不可构造。 */
class FakeWebContents {
  destroyed = false
  closed = false
  readonly sends: unknown[][] = []
  loadFile = vi.fn(async () => undefined)
  executeJavaScript = vi.fn(async () => true)
  focus = vi.fn()
  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.closed = true
    this.destroyed = true
  }

  send(...args: unknown[]): void {
    this.sends.push(args)
  }
}

class FakeView {
  readonly webContents = new FakeWebContents()
  bounds: { x: number; y: number; width: number; height: number } | null = null
  visible = true
  background: string | null = null

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }

  setBackgroundColor(color: string): void {
    this.background = color
  }
}

class FakeWindow {
  destroyed = false
  readonly views: FakeView[] = []
  readonly resizeListeners: Array<() => void> = []
  size: [number, number] = [1000, 700]
  shown = false

  readonly contentView = {
    children: this.views,
    addChildView: (view: FakeView): void => {
      // 真实 Electron 对已在树中的视图是 z-order 移动而非重复添加
      const index = this.views.indexOf(view)
      if (index >= 0) this.views.splice(index, 1)
      this.views.push(view)
    },
    removeChildView: (view: FakeView): void => {
      const index = this.views.indexOf(view)
      if (index >= 0) this.views.splice(index, 1)
    },
  }

  on(event: string, listener: () => void): void {
    if (event === 'resize') this.resizeListeners.push(listener)
  }

  off(event: string, listener: () => void): void {
    if (event === 'resize') {
      const index = this.resizeListeners.indexOf(listener)
      if (index >= 0) this.resizeListeners.splice(index, 1)
    }
  }

  getContentSize(): [number, number] {
    return this.size
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  show(): void {
    this.shown = true
  }
}

function makeFakes() {
  const win = new FakeWindow()
  const splashView = new FakeView()
  const webuiView = new FakeView()
  const controller = createSplashController(
    win as unknown as BaseWindow,
    {
      createView: (kind) => (kind === 'splash' ? splashView : webuiView) as unknown as WebContentsView,
    },
  )
  return { win, splashView, webuiView, controller }
}

describe('splashBackgroundColor', () => {
  it('Windows 全不透明（primary 在启动页下方预加载），macOS 透明透 vibrancy', () => {
    expect(splashBackgroundColor('win32')).toBe('#f8f8fa')
    expect(splashBackgroundColor('darwin')).toBe('#00000000')
  })
})

describe('attachWebui 资源模型', () => {
  it('borrowed primary：不新建视图、不 setBounds/setVisible，dispose 不关闭 primary', async () => {
    const win = new FakeWindow()
    const primary = new FakeWebContents()
    const controller = createSplashController(
      win as unknown as BaseWindow,
      { primary: primary as unknown as WebContents },
    )
    const resource = controller.attachWebui({ visible: false })
    expect(resource.ownership).toBe('borrowed')
    if (resource.ownership !== 'borrowed') return
    expect(resource.contents).toBe(primary)
    expect(win.views.length).toBe(0)
    controller.dispose()
    expect(primary.closed).toBe(false)
    expect(primary.destroyed).toBe(false)
  })

  it('owned child：压入 contentView、resize 跟随窗口、dispose 关闭并摘除', async () => {
    const { win, webuiView, controller } = makeFakes()
    const resource = controller.attachWebui({ visible: false })
    expect(resource.ownership).toBe('owned')
    expect(win.views).toContain(webuiView)
    expect(webuiView.visible).toBe(false)
    // 窗口 resize → 只有 owned view 的 bounds 被同步
    win.size = [1200, 800]
    win.resizeListeners.forEach(listener => listener())
    expect(webuiView.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
    controller.dispose()
    expect(webuiView.webContents.closed).toBe(true)
    expect(win.views).not.toContain(webuiView)
  })

  it('repeat attachWebui：先释放上一代 owned view（restart 语义）', async () => {
    const win = new FakeWindow()
    const first = new FakeView()
    let next: FakeView = first
    const controller = createSplashController(
      win as unknown as BaseWindow,
      { createView: () => { const created = next; next = new FakeView(); return created as unknown as WebContentsView } },
    )
    controller.attachWebui({ visible: false })
    controller.attachWebui({ visible: false })
    expect(first.webContents.closed).toBe(true)
    expect(win.views).toHaveLength(1)
  })
})

describe('splash 生命周期', () => {
  it('attachSplash：Windows 用不透明底，show 窗口', async () => {
    const win = new FakeWindow()
    const splashView = new FakeView()
    const controller = createSplashController(
      win as unknown as BaseWindow,
      { createView: (kind) => (kind === 'splash' ? splashView : new FakeView()) as unknown as WebContentsView, platform: 'win32' },
    )
    await controller.attachSplash()
    expect(splashView.background).toBe('#f8f8fa')
    expect(win.shown).toBe(true)
    expect(win.views).toContain(splashView)
  })

  it('macOS attachSplash 保持透明底', async () => {
    const win = new FakeWindow()
    const splashView = new FakeView()
    const controller = createSplashController(
      win as unknown as BaseWindow,
      { createView: (kind) => (kind === 'splash' ? splashView : new FakeView()) as unknown as WebContentsView, platform: 'darwin' },
    )
    await controller.attachSplash()
    expect(splashView.background).toBe('#00000000')
  })

  it('reveal：owned child 变可见、splash 摘除、焦点交 WebUI；重复调用安全', async () => {
    const { win, splashView, webuiView, controller } = makeFakes()
    await controller.attachSplash()
    controller.attachWebui({ visible: false })
    await controller.reveal()
    expect(webuiView.visible).toBe(true)
    expect(win.views).not.toContain(splashView)
    // 已经摘除 splash 后再次 reveal 不抛
    await controller.reveal()
    expect(webuiView.webContents.focus).toHaveBeenCalled()
  })

  it('dispose 幂等：splash 摘除、owned 释放、resize 监听注销', async () => {
    const { win, splashView, webuiView, controller } = makeFakes()
    await controller.attachSplash()
    controller.attachWebui({ visible: false })
    controller.dispose()
    expect(webuiView.webContents.closed).toBe(true)
    expect(win.views).not.toContain(splashView)
    expect(win.views).not.toContain(webuiView)
    const listenersBefore = win.resizeListeners.length
    controller.dispose()
    expect(listenersBefore).toBe(0)
  })
})

describe('releaseWebuiResource', () => {
  it('borrowed 资源绝不 close；owned 资源从树中摘除并 close', () => {
    const win = new FakeWindow()
    const primary = new FakeWebContents()
    const owned = new FakeView()
    win.views.push(owned)
    releaseWebuiResource(win as unknown as BaseWindow, { ownership: 'borrowed', contents: primary as unknown as WebContents, view: null })
    expect(primary.closed).toBe(false)
    releaseWebuiResource(win as unknown as BaseWindow, { ownership: 'owned', contents: owned.webContents as unknown as WebContents, view: owned as unknown as WebContentsView })
    expect(owned.webContents.closed).toBe(true)
    expect(win.views).not.toContain(owned)
    // null 安全
    releaseWebuiResource(win as unknown as BaseWindow, null)
  })
})