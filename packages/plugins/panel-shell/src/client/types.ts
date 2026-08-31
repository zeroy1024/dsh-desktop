/**
 * 本地结构化类型契约（desktop-frame / activity-group 的 types.ts 先例）。
 *
 * 本插件消费的「缝」由 patches/0006-ui-layout-panel-seam.patch 引入上游
 * ui-layout（权威定义在 upstream/packages/client/ui-layout/src/client/index.ts
 * 的 'panel' 槽声明），本插件自身再声明 panel-shell.page 页面缝。按边界铁律
 * 我们不 import 上游 src，vendor tarball 又是 gitignore 的（devDep 指进去会让
 * 新克隆装不了依赖），因此这里按结构逐字镜像插件实际触碰的类型面：
 *
 * - 运行时值导入（ui-primitives 的 Menu/图标）走 ui-primitives.d.ts 的
 *   ambient 声明——bundle 时它们是 external，由加载器模块表在浏览器里解析；
 * - 纯类型导入全部改指本文件；升级上游 pin 时若 0006 缝形状有变，tsc 不会
 *   自动发现漂移，需对照上述权威文件人工核对（补丁可退役的判据也记录在
 *   patches.yml 的 0006 条目里）。
 */
import type { ReactNode } from 'react'
import type { PanelShellController } from './registry.ts'
import type { PanelLedger } from './panel-store.ts'

/* ===== 1. 契约面（镜像 fork ui-panel-shell 的 contract/slots.ts + registry.ts）===== */

/** panel-shell.page 座位的 owner 货币（容器在渲染点按座位决定）。 */
export interface PanelPageOwnerProps {
  /**
   * 本页是否为激活 tab。false 的座位保持挂载（切回不重置页面状态），
   * 页面应停掉昂贵订阅、暂停轮询。
   */
  active: boolean
}

/** 页面插件的渲染半：容器提供的 panel-shell.page 渲染委托。 */
export type RenderPanelPageSlot = (
  key: 'panel-shell.page',
  owner: PanelPageOwnerProps,
  opts?: { only: string },
) => ReactNode

/** 命名空间地址化翻译座位（locale 插件的 ctx.locale.bind 产物）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/* ===== 2. 客户端 Context（插件 apply 收到的服务面切片）===== */

export interface ClientContext {
  /** 声明 effect 及其释放器（apply 作用域的组册，插件卸载时统一回收）。 */
  effect: (fn: () => (() => void) | void, name: string) => void
  /** 提供命名服务（panelShell 注册表），供页面插件经 ctx 服务面读取。 */
  reflect: {
    provide: (key: string, value: unknown) => () => void
  }
  slots: {
    /** 声明「本插件作为某槽的占位者」的装配工厂（框架在渲染点调用）。 */
    inject: (name: string, factory: () => unknown) => unknown
    /** 注册一个座位条目，返回撤销器。 */
    register: (
      opts: {
        name: string
        locale?: string
        id?: string
        order?: number
        /** 容器在渲染点为子槽提供渲染委托 + 容器自持注入面。 */
        children?: Record<string, { kind: 'list' | 'single'; scope: string }>
        inject?: () => unknown
      },
      component: unknown,
    ) => unknown
    /** 枚举某槽的已注册条目（对账用）。 */
    entries: (name: string) => ReadonlyArray<{ options: { id?: string } }>
    /** 订阅某槽的条目变动（对账用）。 */
    subscribe: (name: string, fn: () => void) => () => void
  }
  locale: {
    /** 注册命名空间词典（zh/en 两份）。 */
    register: (ns: string, dicts: Record<string, Record<string, string>>) => void
    /** 绑定命名空间，返回随激活语言变化的翻译函数。 */
    bind: (ns: string) => Translate
  }
}

/** 页面插件视角的 ctx.panelShell（reflect 提供的服务面）。 */
export interface PanelShellContext extends ClientContext {
  panelShell: PanelShellController
}

/* ===== 3. 容器与页面的组件 props（渲染半的注入货币）===== */

/** 容器完整 props：运行时座位 + 容器自持注入面 + 翻译座位。 */
export interface PanelShellComponentProps {
  registry: PanelShellController
  ledger: PanelLedger
  renderSlot: RenderPanelPageSlot
  t: Translate
}

declare global {
  interface Window {
    dshDesktop?: { platform?: string; dev?: boolean }
  }
}
