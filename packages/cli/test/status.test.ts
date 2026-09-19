import { describe, expect, it } from 'vitest';

import { root, run } from './run.js';

describe('epochnotes status', () => {
  it('exits 2 and says what to do when the cluster does not answer', async () => {
    const { code, out } = await run(
      'status',
      '--registry',
      `${root}registry/entries`,
      '--rpc-url',
      'http://127.0.0.1:9',
    );
    expect(code).toBe(2);
    expect(out).toContain('did not answer');
    expect(out).toContain('--rpc-url');
  });

  it('treats an unknown cluster as a usage error, not as findings', async () => {
    expect((await run('status', '--cluster', 'moonnet')).code).toBe(2);
  });
});
