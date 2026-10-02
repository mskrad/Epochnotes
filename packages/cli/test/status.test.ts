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
    expect(out).toContain('Cannot read chain');
    expect(out).toContain('--rpc-url');
  });

  it('treats an unknown cluster or chain as a usage error, not as findings', async () => {
    expect((await run('status', '--cluster', 'moonnet')).code).toBe(2);
    const named = await run('status', '--chain', 'moonnet');
    expect(named.code).toBe(2);
    expect(named.out).toContain('"moonnet" is not a chain');
  });

  it('reads a chain it has no adapter for as unknown, and says which entries are about other chains', async () => {
    // No network: without an adapter nothing is asked of any endpoint.
    const { code, stdout } = await run(
      'status',
      '--chain',
      'eip155:1',
      '--registry',
      `${root}registry/entries`,
      '--json',
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      chain: string;
      activations: unknown[];
      withoutActivation: { reason: string }[];
    };
    expect(report.chain).toBe('eip155:1');
    expect(report.withoutActivation.map((item) => item.reason)).toEqual(
      Array(4).fill('no activation on this chain; it activates on solana'),
    );
  });
});
