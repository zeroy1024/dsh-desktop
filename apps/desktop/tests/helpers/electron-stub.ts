/**
 * electron-stub.ts — 桌面单测的 electron 包替身（经 vitest resolve.alias 接入）。
 *
 * 背景：src/main 各模块在模块顶层 value-import 'electron'，而真实 electron
 * 包在纯 Node 测试进程里被 require 时，其 index.js 会检查 path.txt/dist，
 * 缺失则同步 spawn install.js 下载二进制——CI 上多个 vitest worker 并发
 * 触发时会对同一 dist 目录竞争解压（Windows 上表现为 os error 80），
 * suite 在加载期直接失败。单测从不该依赖真实二进制。
 *
 * 语义：真实包在纯 Node 下 module.exports 是二进制路径字符串，命名解构
 * 恒得 undefined——本 stub 复刻同一语义（全部具名导出为 undefined），
 * 因此任何suite 的行为与加载真实包完全一致；误用（如 app.getPath）会以
 * 与今天相同的 TypeError 暴露，提示该测试应自行注入 fake。
 *
 * 与 vi.doMock 的衔接：alias 先把 'electron' 解析到本文件，doMock 再按
 * 同一模块 id 拦截，行为测试（main-process*.spec.ts 的 harness）照常拿到
 * 各自的结构 fake，不受本 stub 影响。
 */

export const app = undefined
export const BaseWindow = undefined
export const BrowserWindow = undefined
export const WebContentsView = undefined
export const dialog = undefined
export const ipcMain = undefined
export const ipcRenderer = undefined
export const contextBridge = undefined
export const nativeImage = undefined
export const nativeTheme = undefined
export const Menu = undefined
export const screen = undefined
export const session = undefined
export const shell = undefined
