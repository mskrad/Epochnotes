import { describe, expect, it } from 'vitest';

import { CLUSTER_GENESIS as GENESIS, probeRpc, validatePath } from '../src/index.js';

const entries = validatePath(new URL('../../../registry/entries', import.meta.url).pathname).files.flatMap(
  (file) => (file.entry === undefined ? [] : [file.entry]),
);
type Answer = { result?: unknown; error?: { code?: number; message?: string } };
type Config = { maxSupportedTransactionVersion?: number };

/** A fake endpoint: the genesis hash it reports and how it answers getTransaction for each config. */
function endpoint(genesis: string, getTransaction: (config: Config) => Answer) {
  const asked: string[] = [];
  const rpc = async (method: string, params: unknown[]): Promise<Answer> => {
    asked.push(method);
    return method === 'getGenesisHash' ? { result: genesis } : getTransaction(params[1] as Config);
  };
  return { rpc, asked };
}
const refusesBelowOne = (config: Config): Answer =>
  config.maxSupportedTransactionVersion === 1
    ? { result: { version: 1 } }
    : { error: { code: -32015, message: 'Transaction version (1) is not supported' } };

describe('probing an RPC endpoint', () => {
  it('reports each call and that the endpoint reads the fixture, quoting what the entry expects', async () => {
    const { rpc } = endpoint(GENESIS['mainnet-beta'], refusesBelowOne);
    const report = await probeRpc('https://rpc.example/?api-key=secret', entries, rpc);
    expect(report.endpoint).not.toContain('secret');
    expect(report.cluster).toBe('mainnet-beta');
    expect(report.probes).toHaveLength(1);
    expect(report.probes[0]).toMatchObject({
      entry: 'tx-v1',
      rule: 'rpc-reads-v1-transaction',
      verdict: 'reads',
      expect: 'Result has version 1 and no JSON-RPC error.',
    });
    expect(report.probes[0]?.calls).toEqual([
      {
        parameter: 'omitted',
        outcome: { ok: false, code: -32015, message: 'Transaction version (1) is not supported' },
      },
      {
        parameter: 0,
        outcome: { ok: false, code: -32015, message: 'Transaction version (1) is not supported' },
      },
      { parameter: 1, outcome: { ok: true, version: '1' } },
    ]);
  });

  it('says cannot-read when the endpoint refuses the fixture with every setting', async () => {
    const { rpc } = endpoint(GENESIS['mainnet-beta'], () => ({ error: { code: -32015, message: 'no' } }));
    expect((await probeRpc('https://rpc.example', entries, rpc)).probes[0]?.verdict).toBe('cannot-read');
  });

  it('tells a pruned fixture from a refusal', async () => {
    const { rpc } = endpoint(GENESIS['mainnet-beta'], () => ({ result: null }));
    expect((await probeRpc('https://rpc.example', entries, rpc)).probes[0]?.verdict).toBe('fixture-missing');
  });

  it('does not run a mainnet fixture against another cluster', async () => {
    const { rpc, asked } = endpoint(GENESIS.devnet, refusesBelowOne);
    const report = await probeRpc('https://rpc.example', entries, rpc);
    expect(report.probes[0]?.verdict).toBe('not-applicable');
    expect(asked).toEqual(['getGenesisHash']);
  });

  it('only ever reads', async () => {
    const { rpc, asked } = endpoint(GENESIS['mainnet-beta'], refusesBelowOne);
    await probeRpc('https://rpc.example', entries, rpc);
    expect(new Set(asked)).toEqual(new Set(['getGenesisHash', 'getTransaction']));
  });

  it('reports an endpoint that does not answer as unreachable', async () => {
    const report = await probeRpc('https://rpc.example', entries, () =>
      Promise.reject(new Error('fetch failed')),
    );
    expect(report.probes[0]).toMatchObject({ verdict: 'unreachable' });
    expect(report.probes[0]?.explanation).toContain('fetch failed');
  });
});
