import { defineConfig } from 'vitest/config';

// Tests that need a running validator with the registry program deployed. `anchor test` provides one.
export default defineConfig({
  test: {
    include: ['packages/core/test-onchain/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
