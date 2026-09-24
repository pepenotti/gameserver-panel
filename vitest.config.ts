import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
