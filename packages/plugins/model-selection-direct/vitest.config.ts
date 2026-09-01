import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/ui-primitives.stub.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
})
