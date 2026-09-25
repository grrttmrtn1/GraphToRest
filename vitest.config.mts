import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    setupFiles: ['test/setup/outboundPolicy.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'web', environment: 'jsdom', include: ['apps/web/test/**/*.test.{ts,tsx}'] },
      },
    ],
  },
});
