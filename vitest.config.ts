import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Tests run against sources, so they do not depend on a prior build.
    alias: { '@epochnotes/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname },
  },
});
