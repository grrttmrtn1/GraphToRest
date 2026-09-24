import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['apps/web/**', 'jsdom']],
    setupFiles: ['test/setup/outboundPolicy.ts'],
  },
});
