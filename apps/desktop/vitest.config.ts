import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 单测在纯 Node 进程跑，永不加载真实 electron 包：其 index.js 在 dist
      // 缺失时会同步 spawn install.js 下载二进制，CI 多 worker 并发下载会对
      // 同一目录竞争解压（Windows 上 os error 80，suite 加载期失败）。行为
      // 测试经 vi.doMock('electron') 注入结构 fake——alias 解析在前、doMock
      // 按同一模块 id 拦截在后，两者不冲突（见 tests/helpers/electron-stub.ts）。
      electron: fileURLToPath(new URL('./tests/helpers/electron-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // 只统计主进程/预加载源码；渲染层（src/renderer）是上游静态产物，不在
      // 统计范围。src/main/index.ts 已接入行为测试（tests/main-process*.spec.ts
      // + tests/helpers/electron-harness.ts），从 exclude 移除。
      //
      // preload 两个文件仍无测试挂载，保持计入统计（诚实反映现状），阈值为
      // 其预留余量。agent.ts/paths.ts（受 index.ts 的 harness stub 影响，转为
      // 零挂载文件）与 bundled-plugins.ts 同理，函数分母不加掩盖。
      include: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
      // 基线实测 3 次（2026-09-04，含 index.ts 挂载后）：stmts 70.55 / branch
      // 61.5 / funcs 63.77 / lines 75.22，三次跑分一致；阈值向下留 ~5 个点的
      // 防抖余量。funcs 被 agent/paths/bundled-plugins 与两个 preload 的零挂载
      // 分母压低，等 preload 测试落地后再上修。
      thresholds: {
        statements: 65,
        branches: 56,
        functions: 58,
        lines: 70,
      },
    },
  },
})
