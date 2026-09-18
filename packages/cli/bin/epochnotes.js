#!/usr/bin/env node
// Committed launcher: it exists before the first build, so `npm ci` can link the `epochnotes` bin.
try {
  await import('../dist/bin.js');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes('dist/bin.js')) throw error;
  console.error(
    'epochnotes is not built yet: packages/cli/dist/bin.js is missing. Run `npm run build` first.',
  );
  process.exit(2);
}
