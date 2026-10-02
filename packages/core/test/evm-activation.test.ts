import { describe, expect, it } from 'vitest';

import {
  type Activation,
  EVM_GENESIS,
  evmActivationReader,
  type JsonRpc,
  readActivations,
  validateEntry,
} from '../src/index.js';

const ETHEREUM_GENESIS = EVM_GENESIS['eip155:1'] as string;

/** A fake EVM endpoint: a chain id, a genesis block (or none, as a pruned node), and a head block. */
function endpoint(options: {
  chainId?: string;
  genesis?: string | 'pruned';
  head: { number: number; timestamp: number; fields?: Record<string, unknown> };
}) {
  const asked: string[] = [];
  const rpc: JsonRpc = async (method, params) => {
    asked.push(`${method} ${JSON.stringify(params)}`);
    if (method === 'eth_chainId') return { result: options.chainId ?? '0x1' };
    if (method === 'eth_getBlockByNumber' && params[0] === '0x0') {
      if (options.genesis === 'pruned')
        return { error: { code: 4444, message: 'pruned history unavailable' } };
      return { result: { number: '0x0', timestamp: '0x0', hash: options.genesis ?? ETHEREUM_GENESIS } };
    }
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest')
      return {
        result: {
          number: `0x${options.head.number.toString(16)}`,
          timestamp: `0x${options.head.timestamp.toString(16)}`,
          hash: '0xabc',
          ...options.head.fields,
        },
      };
    return { error: { code: -32601, message: `no ${method}` } };
  };
  return { rpc, asked };
}

const fork = (at: number, header?: string): Activation => ({
  kind: 'timestamp',
  chain: 'eip155:1',
  at,
  label: 'sample',
  ...(header === undefined ? {} : { evidence: { header } }),
});

async function stateOf(
  activation: Activation,
  head: { number: number; timestamp: number; fields?: Record<string, unknown> },
) {
  const { rpc } = endpoint({ head });
  const { states } = await evmActivationReader(rpc).read([activation]);
  return states[0];
}

describe('reading a fork by time on an EVM chain', () => {
  it('is active and confirmed by the header when the time has passed and the head block carries the field', async () => {
    expect(
      await stateOf(fork(100, 'requestsHash'), {
        number: 5,
        timestamp: 200,
        fields: { requestsHash: '0x1' },
      }),
    ).toEqual({
      state: 'active',
      since: { time: '100' },
      confirmedBy: 'header',
    });
  });

  it('is active by time only, and says so, when the entry names no header field', async () => {
    expect(await stateOf(fork(100), { number: 5, timestamp: 200 })).toEqual({
      state: 'active',
      since: { time: '100' },
      confirmedBy: 'time-only',
    });
  });

  it('is scheduled before its time, and never absent: an entry that names a fork time names a scheduled fork', async () => {
    expect(await stateOf(fork(300, 'requestsHash'), { number: 5, timestamp: 200 })).toEqual({
      state: 'scheduled',
    });
    expect(await stateOf(fork(300), { number: 5, timestamp: 200 })).toEqual({ state: 'scheduled' });
  });

  it('is unknown, with the reason, when the time and the header disagree either way', async () => {
    expect(await stateOf(fork(100, 'requestsHash'), { number: 5, timestamp: 200 })).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/has passed, but the head block has no requestsHash/),
    });
    expect(
      await stateOf(fork(100, 'requestsHash'), { number: 5, timestamp: 200, fields: { requestsHash: null } }),
    ).toMatchObject({
      state: 'unknown',
    });
    expect(
      await stateOf(fork(300, 'requestsHash'), {
        number: 5,
        timestamp: 200,
        fields: { requestsHash: '0x1' },
      }),
    ).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/already has requestsHash, though the fork time 300 has not come/),
    });
  });

  it('reads a fork by height against the number of the head block', async () => {
    const height: Activation = { kind: 'block-height', chain: 'eip155:1', at: 10, label: 'h' };
    expect(await stateOf(height, { number: 10, timestamp: 1 })).toEqual({
      state: 'active',
      since: { block: '10' },
      confirmedBy: 'height-only',
    });
    expect(await stateOf(height, { number: 9, timestamp: 1 })).toEqual({ state: 'scheduled' });
  });

  it('names the point of the reading: the head block and its time', async () => {
    const { rpc } = endpoint({ head: { number: 26_106_412, timestamp: 1_790_965_475 } });
    expect((await evmActivationReader(rpc).read([fork(1)])).point).toEqual({
      block: '26106412',
      time: '1790965475',
    });
  });
});

describe('which EVM chain an endpoint serves', () => {
  it('is the chain id it states, confirmed by the genesis block where this library pins one', async () => {
    expect(await evmActivationReader(endpoint({ head: { number: 1, timestamp: 1 } }).rpc).identify()).toEqual(
      {
        chain: 'eip155:1',
        by: 'genesis',
      },
    );
  });

  it('refuses an endpoint whose genesis block is not the pinned one: a chain id can be reused, a genesis cannot', async () => {
    const impostor = endpoint({ genesis: `0x${'1'.repeat(64)}`, head: { number: 1, timestamp: 1 } });
    await expect(evmActivationReader(impostor.rpc).identify()).rejects.toThrow(
      /says it serves eip155:1, but its genesis block is 0x1{64}/,
    );
  });

  it('falls back to the chain id, and says so, when a pruned endpoint cannot return the genesis block', async () => {
    const pruned = endpoint({ chainId: '0x2105', genesis: 'pruned', head: { number: 1, timestamp: 1 } });
    expect(await evmActivationReader(pruned.rpc).identify()).toEqual({
      chain: 'eip155:8453',
      by: 'chain-id',
    });
  });

  it('knows a chain it pins no genesis for by its chain id only', async () => {
    const other = endpoint({ chainId: '0xa', head: { number: 1, timestamp: 1 } });
    expect(await evmActivationReader(other.rpc).identify()).toEqual({ chain: 'eip155:10', by: 'chain-id' });
    expect(other.asked.some((call) => call.includes('0x0'))).toBe(false);
  });

  it('refuses an answer that is not a hex quantity, instead of naming a chain from it', async () => {
    const odd = endpoint({ chainId: 'one', head: { number: 1, timestamp: 1 } });
    await expect(evmActivationReader(odd.rpc).identify()).rejects.toThrow(/returned "one" for eth_chainId/);
  });
});

describe('an EVM chain through the shared reading', () => {
  it('reads only the activations of that chain, and names the entries about others', async () => {
    const entry = validateEntry({
      schema_version: 2,
      id: 'two-chains',
      rev: 1,
      axis: 'protocol',
      subject: { standard: 'eip', name: 'EIP-0000', title: 'Sample' },
      applies: {
        activations: [
          {
            kind: 'timestamp',
            chain: 'eip155:1',
            at: 100,
            label: 'on-ethereum',
            evidence: { header: 'requestsHash' },
          },
          { kind: 'timestamp', chain: 'eip155:8453', at: 100, label: 'on-base' },
        ],
      },
      breaks: [{ surface: 'program', summary: 's' }],
      fix: [{ summary: 'f' }],
      sources: [{ kind: 'proposal', ref: 'r', retrieved: '2026-10-02' }],
    });
    if (!entry.ok) throw new Error(JSON.stringify(entry.issues));
    const { rpc } = endpoint({ head: { number: 7, timestamp: 200, fields: { requestsHash: '0x1' } } });
    const reading = await readActivations([entry.entry], evmActivationReader(rpc), 'eip155:1');
    expect(reading).toMatchObject({ chain: 'eip155:1', name: 'ethereum', identifiedBy: 'genesis' });
    expect(reading.activations.map((item) => [item.activation.label, item.status.state])).toEqual([
      ['on-ethereum', 'active'],
    ]);
  });
});
