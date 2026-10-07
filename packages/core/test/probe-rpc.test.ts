import { describe, expect, it } from 'vitest';

import {
  CLUSTER_GENESIS as GENESIS,
  type Entry,
  EVM_GENESIS,
  probeOf,
  probeRpc,
  type RpcProbeReport,
  validatePath,
} from '../src/index.js';

const entriesOf = (path: string) =>
  validatePath(new URL(path, import.meta.url).pathname).files.flatMap((file) =>
    file.entry === undefined ? [] : [file.entry],
  );
const entries = entriesOf('../../../registry/entries');
const schema1 = entriesOf('./fixtures/schema-v1');

type Answer = { result?: unknown; error?: { code?: number; message?: string } };
type Config = { maxSupportedTransactionVersion?: number };

/** A fake Solana endpoint: the genesis hash it reports and how it answers getTransaction for each config. */
function solana(genesis: string, getTransaction: (config: Config) => Answer) {
  const asked: string[] = [];
  const rpc = async (method: string, params: unknown[]): Promise<Answer> => {
    asked.push(method);
    if (method === 'getGenesisHash') return { result: genesis };
    if (method === 'getTransaction') return getTransaction(params[1] as Config);
    return { error: { code: -32601, message: `Method not found: ${method}` } };
  };
  return { rpc, asked };
}

/** A fake EVM endpoint: a chain id, its genesis block, and how it answers eth_getTransactionByHash. */
function evm(chainId: string, genesis: string, transaction: (hash: string) => Answer) {
  const asked: string[] = [];
  const rpc = async (method: string, params: unknown[]): Promise<Answer> => {
    asked.push(method);
    if (method === 'eth_chainId') return { result: chainId };
    if (method === 'eth_getBlockByNumber' && params[0] === '0x0')
      return { result: { number: '0x0', hash: genesis } };
    if (method === 'eth_getTransactionByHash') return transaction(params[0] as string);
    return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
  };
  return { rpc, asked };
}

const refusesBelowOne = (config: Config): Answer =>
  config.maxSupportedTransactionVersion === 1
    ? { result: { version: 1 } }
    : { error: { code: -32015, message: 'Transaction version (1) is not supported' } };

const probe = (report: RpcProbeReport, rule: string) => report.probes.find((item) => item.rule === rule);
const TX_V1 = 'rpc-reads-v1-transaction';
const ETHEREUM = 'ethereum-provider-returns-set-code-transaction';
const BASE = 'base-provider-returns-set-code-transaction';

describe('probing a Solana endpoint', () => {
  it('records the same observations as before the probes became data: three calls, a version or an error each', async () => {
    const { rpc } = solana(GENESIS['mainnet-beta'], refusesBelowOne);
    const report = await probeRpc('https://rpc.example/?api-key=secret', entries, rpc);
    expect(report.endpoint).not.toContain('secret');
    expect(report).toMatchObject({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', name: 'mainnet-beta' });
    expect(probe(report, TX_V1)).toMatchObject({
      entry: 'tx-v1',
      verdict: 'reads',
      expect: 'Result has version 1 and no JSON-RPC error.',
    });
    // Parameter omitted, 0, 1 → error, error, version 1: call by call, as the probe has always recorded them.
    expect(probe(report, TX_V1)?.calls).toEqual([
      {
        call: 'version-omitted',
        method: 'getTransaction',
        outcome: { ok: false, code: -32015, message: 'Transaction version (1) is not supported' },
      },
      {
        call: 'version-0',
        method: 'getTransaction',
        outcome: { ok: false, code: -32015, message: 'Transaction version (1) is not supported' },
      },
      {
        call: 'version-1',
        method: 'getTransaction',
        outcome: { ok: true, observed: { 'result.version': 1 } },
      },
    ]);
  });

  it('runs a schema-1 probe, which named only its method, as the same three calls', async () => {
    const { rpc, asked } = solana(GENESIS['mainnet-beta'], refusesBelowOne);
    const report = await probeRpc('https://rpc.example', schema1, rpc);
    expect(probe(report, TX_V1)?.verdict).toBe('reads');
    expect(asked.filter((method) => method === 'getTransaction')).toHaveLength(3);
    const [v1, v2] = [schema1, entries].map((list) => {
      const rule = list
        .find((entry: Entry) => entry.id === 'tx-v1')
        ?.detect.find((item) => item.kind === 'runtime-probe');
      return rule?.kind === 'runtime-probe' ? probeOf(rule.probe) : undefined;
    });
    expect({ ...v1, fixture: undefined }).toEqual({ ...v2, fixture: undefined });
  });

  it('says cannot-read when the endpoint refuses the fixture with every setting', async () => {
    const { rpc } = solana(GENESIS['mainnet-beta'], () => ({ error: { code: -32015, message: 'no' } }));
    const report = await probeRpc('https://rpc.example', entries, rpc);
    expect(probe(report, TX_V1)?.verdict).toBe('cannot-read');
    expect(probe(report, TX_V1)?.explanation).toContain('version-1 result.version is null, not 1');
  });

  it('passes only on the call the entry names: version 1 read with version 1', async () => {
    // An endpoint that reads the transaction only without the parameter, which a non-conforming one might do.
    const { rpc } = solana(GENESIS['mainnet-beta'], (config) =>
      config.maxSupportedTransactionVersion === undefined
        ? { result: { version: 1 } }
        : { error: { code: -32602, message: 'bad param' } },
    );
    expect(probe(await probeRpc('https://rpc.example', entries, rpc), TX_V1)?.verdict).toBe('cannot-read');
  });

  it('takes an error without a code for a refusal, not for a pruned history', async () => {
    const { rpc } = solana(GENESIS['mainnet-beta'], () => ({ error: { message: 'refused' } }));
    expect(probe(await probeRpc('https://rpc.example', entries, rpc), TX_V1)?.verdict).toBe('cannot-read');
  });

  it('tells a pruned fixture from a refusal', async () => {
    const { rpc } = solana(GENESIS['mainnet-beta'], () => ({ result: null }));
    expect(probe(await probeRpc('https://rpc.example', entries, rpc), TX_V1)?.verdict).toBe(
      'fixture-missing',
    );
  });

  it('does not run a mainnet fixture against another cluster, nor an EVM fixture against Solana', async () => {
    const { rpc, asked } = solana(GENESIS.devnet, refusesBelowOne);
    const report = await probeRpc('https://rpc.example', entries, rpc);
    expect(report.probes.map((item) => item.verdict)).toEqual([
      'not-applicable',
      'not-applicable',
      'not-applicable',
    ]);
    expect(asked).toEqual(['getGenesisHash']);
  });
});

describe('probing an EVM endpoint', () => {
  const setCode = (hash: string): Answer => ({
    result: { hash, type: '0x4', authorizationList: [{ address: '0x7702' }] },
  });

  it('is identified by its chain id and genesis block, and runs the probe of its own chain only', async () => {
    const { rpc, asked } = evm('0x1', EVM_GENESIS['eip155:1'] as string, setCode);
    const report = await probeRpc('https://rpc.example', entries, rpc);
    expect(report).toMatchObject({ chain: 'eip155:1', name: 'ethereum', observed: 1 });
    expect(probe(report, ETHEREUM)).toMatchObject({
      verdict: 'reads',
      calls: [
        {
          call: 'transaction',
          method: 'eth_getTransactionByHash',
          outcome: { ok: true, observed: { 'result.type': '0x4', 'result.authorizationList.length': 1 } },
        },
      ],
    });
    expect(probe(report, BASE)?.verdict).toBe('not-applicable');
    expect(probe(report, TX_V1)?.verdict).toBe('not-applicable');
    // The fixture id is put in for $fixture.
    expect(asked).toContain('eth_getTransactionByHash');
  });

  it('says cannot-read when a provider drops the authorization list, and names what it saw', async () => {
    const { rpc } = evm('0x2105', EVM_GENESIS['eip155:8453'] as string, (hash) => ({
      result: { hash, type: '0x4' },
    }));
    const report = await probeRpc('https://rpc.example', entries, rpc);
    expect(probe(report, BASE)?.verdict).toBe('cannot-read');
    expect(probe(report, BASE)?.explanation).toContain('result.authorizationList.length is null, not 1');
  });

  it('identifies an EVM endpoint that refuses the Solana question at the HTTP level', async () => {
    const base = evm('0x2105', EVM_GENESIS['eip155:8453'] as string, setCode);
    const rpc = async (method: string, params: unknown[]) => {
      if (method === 'getGenesisHash') throw new Error('HTTP 403');
      return base.rpc(method, params);
    };
    expect(probe(await probeRpc('https://rpc.example', entries, rpc), BASE)?.verdict).toBe('reads');
  });
});

describe('a probe only ever reads', () => {
  it('never calls a method outside the read-only list, even from an entry that was not validated', async () => {
    const eth = entries.find((entry) => entry.id === 'eip-7702') as Entry;
    // An entry that a validator would refuse, handed to the engine directly.
    const writing = {
      ...eth,
      detect: eth.detect.map((rule) =>
        rule.kind === 'runtime-probe' && 'calls' in rule.probe
          ? {
              ...rule,
              probe: {
                ...rule.probe,
                calls: [{ id: 'transaction', method: 'eth_sendRawTransaction', params: ['$fixture'] }],
              },
            }
          : rule,
      ),
    } as Entry;
    const { rpc, asked } = evm('0x1', EVM_GENESIS['eip155:1'] as string, () => ({ result: {} }));
    const report = await probeRpc('https://rpc.example', [writing], rpc);
    expect(asked).not.toContain('eth_sendRawTransaction');
    expect(probe(report, ETHEREUM)).toMatchObject({
      verdict: 'not-applicable',
      explanation: 'This tool does not call eth_sendRawTransaction: a probe may only read.',
    });
  });
});

describe('what the report says about the run', () => {
  it('only ever reads', async () => {
    const { rpc, asked } = solana(GENESIS['mainnet-beta'], refusesBelowOne);
    await probeRpc('https://rpc.example', entries, rpc);
    expect(new Set(asked)).toEqual(new Set(['getGenesisHash', 'getTransaction']));
  });

  it('keeps credentials out of the report when the transport quotes the endpoint in its error', async () => {
    // The real transport: fetch refuses a URL with credentials and repeats it in the message.
    const report = await probeRpc('http://user:hunter2@127.0.0.1:1/', entries);
    expect(report.probes[0]?.verdict).toBe('unreachable');
    expect(JSON.stringify(report)).not.toContain('hunter2');
    const unparsable = await probeRpc('not a url hunter2', entries);
    expect(unparsable.probes[0]?.verdict).toBe('unreachable');
    expect(JSON.stringify(unparsable)).not.toContain('hunter2');
  });

  it('counts the probes that observed something, so that nothing observed does not read as a pass', async () => {
    const live = solana(GENESIS['mainnet-beta'], refusesBelowOne);
    expect((await probeRpc('https://rpc.example', entries, live.rpc)).observed).toBe(1);
    const elsewhere = solana(GENESIS.devnet, refusesBelowOne);
    expect((await probeRpc('https://rpc.example', entries, elsewhere.rpc)).observed).toBe(0);
    const pruned = solana(GENESIS['mainnet-beta'], () => ({ result: null }));
    expect((await probeRpc('https://rpc.example', entries, pruned.rpc)).observed).toBe(0);
  });

  it('reports an endpoint that answers neither question as unreachable', async () => {
    const report = await probeRpc('https://rpc.example', entries, () =>
      Promise.reject(new Error('fetch failed')),
    );
    expect(report.probes[0]).toMatchObject({ verdict: 'unreachable' });
    expect(report.probes[0]?.explanation).toContain('fetch failed');
  });
});
