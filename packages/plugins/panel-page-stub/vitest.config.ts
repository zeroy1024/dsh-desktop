import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // 演示页无单测（容器协议测试在 panel-shell 内），避免空目录退非零。
    passWithNoTests: true,
  },
})
