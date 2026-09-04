import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      // 只统计 src（纯 Node 库）；index.ts 仅 re-export，无实际逻辑
      include: ['src/**/*.ts'],
      // 基线实测：stmts 89.47 / branch 77.96 / funcs 88.33 / lines 91.86，
      // 阈值向下留 ~5-8 个点的防抖余量
      thresholds: {
        statements: 82,
        branches: 70,
        functions: 82,
        lines: 85,
      },
    },
  },
})
