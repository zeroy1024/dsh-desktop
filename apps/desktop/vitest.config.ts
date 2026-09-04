import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // 只统计主进程/预加载源码；渲染层（src/renderer）是上游静态产物，不在
      // 统计范围。
      //
      // TODO(src/main/index.ts)：Electron 主进程入口（app 生命周期、窗口装配、
      // ipcMain 处理器），import 即执行 Electron API，无法在纯 Node vitest 中
      // 挂载，实测贡献 0% 并拖垮全局数字；待 app 级集成测试落地后移除
      // exclude 并重新校准阈值。preload 两个文件同样尚无测试挂载，保持计入
      // 统计（诚实反映现状），阈值为其预留余量。
      include: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
      exclude: ['src/main/index.ts'],
      // 基线实测（不含 index.ts，仍计入 0% 挂载的 agent/bundled-plugins/paths/
      // window-state 与两个 preload 文件）：stmts 65.15 / branch 66 /
      // funcs 48.48 / lines 66.98；阈值向下留 ~5 个点的防抖余量。funcs 被
      // 零挂载文件的函数分母压低，等集成测试把 index.ts/preload 挂上后再上修。
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 42,
        lines: 62,
      },
    },
  },
})
