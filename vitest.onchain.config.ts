import { defineConfig } from 'vitest/config';

// Tests that need a running validator with the registry program deployed. `anchor test` provides one.
export default defineConfig({
  test: {
    include: ['packages/*/test-onchain/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    alias: { '@epochnotes/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname },
  },
});
