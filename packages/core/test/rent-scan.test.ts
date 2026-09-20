import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  anchorDiscriminator,
  type FeatureAccountSource,
  KNOWN_PROGRAMS,
  type RentRpc,
  rentRpc,
  type RentSchedule,
  sampleProgram,
  scanProgram,
  scanWallet,
} from '../src/index.js';

const OPENBOOK = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
const WALLET = '6VGzWhwbqcYjxWZePEonjkqC77PnWkZDrKyTwyZs2gDb';
const schedule: RentSchedule = {
  entry: 'test',
  rev: 1,
  legacyRate: 1000n,
  steps: [
    { rate: 500n, gate: 'Gate1111111111111111111111111111111111111111', label: 'first' },
    { rate: 100n, gate: 'Gate2222222222222222222222222222222222222222', label: 'second' },
  ],
};
const gates: FeatureAccountSource = {
  getAccounts: async (addresses) => ({ slot: 9n, accounts: addresses.map(() => null) }),
};
const sysvar = (rate: bigint) => {
  const data = Buffer.alloc(17);
  data.writeBigUInt64LE(rate, 0);
  return { context: { slot: 9 }, value: { data: [data.toString('base64'), 'base64'] } };
};
const account = (type: string, lamports: number, space: number) => ({
  pubkey: 'x',
  account: {
    lamports,
    space,
    data: [Buffer.from(anchorDiscriminator(type), 'hex').toString('base64'), 'base64'],
  },
});

/** Whether a request asks for accounts of one exact size, and which. */
const sizeAsked = (params: unknown[]): number | undefined =>
  (params[1] as { filters?: { dataSize?: number }[] }).filters?.find(
    (filter) => filter.dataSize !== undefined,
  )?.dataSize;

/** In the fakes below the callback answers the sampled groups; exact-size requests find nothing unless `short` says otherwise. */
function fake(
  accounts: (params: unknown[]) => unknown,
  rate = 500n,
  short: (size: number) => unknown[] = () => [],
) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: RentRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getAccountInfo') return { result: sysvar(rate) };
    const size = method === 'getProgramAccounts' ? sizeAsked(params) : undefined;
    return { result: size === undefined ? accounts(params) : short(size) };
  };
  return { rpc, calls, options: { rpc, gates, endpoint: 'https://rpc.example/?api-key=secret', schedule } };
}

describe('the table of known programs', () => {
  it('derives the three discriminators checked by hand against the on-chain IDLs', () => {
    // marginfi lists discriminators in its IDL; for OpenBook v2 and Drift the value is confirmed by live scans
    // filling the bucket of that type.
    expect(anchorDiscriminator('OpenOrdersAccount')).toBe('ffc24e7b1069d0a5');
    expect(anchorDiscriminator('MarginfiAccount')).toBe('43b2826d7e721c2a');
    expect(anchorDiscriminator('User')).toBe('9f755fe3ef973aec');
  });

  it('calls no Drift account closable while the deployed program rejects its close instructions, and says why', () => {
    const drift = KNOWN_PROGRAMS.find((program) => program.name === 'Drift');
    expect(drift?.types.length).toBeGreaterThan(0);
    expect(drift?.types.every((type) => type.closableBy === 'nobody')).toBe(true);
    expect(drift?.note).toContain('InstructionFallbackNotFound');
    // Still searchable by wallet: a person should see the deposit even though nobody can return it today.
    expect(drift?.types.filter((type) => type.ownerOffset === 8).map((type) => type.name)).toEqual([
      'User',
      'UserStats',
    ]);
  });

  it('names, for every program, the source tree its close constraints were read in', () => {
    for (const program of KNOWN_PROGRAMS)
      expect(program.source).toMatch(/^github\.com\/[\w-]+\/[\w.-]+ @ [0-9a-f]{12}$/);
  });

  it('is internally consistent: a close instruction for every closable type, none for the rest', () => {
    for (const program of KNOWN_PROGRAMS)
      for (const type of program.types)
        expect(type.closeInstruction === undefined, `${program.name} ${type.name}`).toBe(
          type.closableBy === 'nobody',
        );
  });
});

describe('scanning a program', () => {
  const accounts = [
    account('OpenOrdersAccount', 200_000, 72), // at the legacy minimum: 100 000 above today's
    account('OpenOrdersAccount', 100_000, 72), // at today's minimum
    account('Market', 200_000, 72),
    account('Market', 5_200_000, 72), // holds something else as well
    account('SomethingNew', 200_000, 72),
  ];

  it('splits accounts by type, says who can close each, and adds up to the total', async () => {
    const { options } = fake(() => ({ context: { slot: 11 }, value: accounts }));
    const report = await scanProgram(OPENBOOK, options);
    expect(report).toMatchObject({ slot: '11', currentRate: 500n, reliability: 'exact', standardError: 0n });
    expect(report.endpoint).not.toContain('secret');
    const byType = Object.fromEntries(report.buckets.map((bucket) => [bucket.type, bucket]));
    expect(byType.OpenOrdersAccount).toMatchObject({
      closableBy: 'owner',
      accounts: 2,
      fundedAtEarlierRate: 1,
      excessNow: 100_000n,
      aboveMinimumUpperBound: 0n,
      afterStep: { '100': 260_000n },
    });
    expect(byType.Market).toMatchObject({
      closableBy: 'admin',
      accounts: 2,
      excessNow: 100_000n,
      aboveMinimumUpperBound: 5_100_000n,
      afterStep: { '100': 360_000n },
    });
    expect(byType.unlisted).toMatchObject({ closableBy: 'unknown', accounts: 1, excessNow: 100_000n });
    expect(report.total).toMatchObject({ accounts: 5, fundedAtEarlierRate: 3, excessNow: 300_000n });
    expect(report.notes.join(' ')).toContain('Anchor discriminator');
  });

  it('asks for 8 bytes of every account and nothing more, and only reads', async () => {
    const { options, calls } = fake(() => ({ context: { slot: 11 }, value: [] }));
    await scanProgram(OPENBOOK, options);
    expect(calls.map((call) => call.method)).toEqual(['getAccountInfo', 'getProgramAccounts']);
    expect(calls[1]?.params[1]).toMatchObject({ dataSlice: { offset: 0, length: 8 } });
  });

  it('does not split a program it does not know, and says so', async () => {
    const { options } = fake(() => ({ context: { slot: 11 }, value: accounts }));
    const report = await scanProgram('11111111111111111111111111111111', options);
    expect(report.buckets.map((bucket) => bucket.type)).toEqual(['all']);
    expect(report.notes[0]).toContain('not split');
  });

  it('reports the gate states it read and flags a sysvar rate the schedule does not know', async () => {
    const { options } = fake(() => ({ context: { slot: 11 }, value: [] }), 777n);
    const report = await scanProgram(OPENBOOK, options);
    expect(report.schedule.steps.map((step) => step.status.state)).toEqual(['absent', 'absent']);
    expect(report.notes.join(' ')).toContain('holds 777, which is not a rate of test');
  });

  it('refuses an endpoint that does not return account sizes instead of computing every minimum for 128 bytes', async () => {
    const sizeless = {
      pubkey: 'x',
      account: { lamports: 200_000, data: account('Market', 0, 0).account.data },
    };
    const { options } = fake(() => ({ context: { slot: 11 }, value: [sizeless] }));
    await expect(scanProgram(OPENBOOK, options)).rejects.toThrow('does not return the size of accounts');
  });

  it('states the assumption behind the later-step figures and where closability was read', async () => {
    const { options } = fake(() => ({ context: { slot: 11 }, value: accounts }));
    const notes = (await scanProgram(OPENBOOK, options)).notes.join(' ');
    expect(notes).toContain('assumed to have been made at that rate');
    expect(notes).toContain('github.com/openbook-dex/openbook-v2 @ ');
    expect(notes).toContain('not a market size');
  });

  it('fails with the RPC error when the program is too large for one request', async () => {
    const rpc: RentRpc = async (method) =>
      method === 'getAccountInfo'
        ? { result: sysvar(500n) }
        : { error: { code: -32603, message: 'too large' } };
    await expect(
      scanProgram(OPENBOOK, { rpc, gates, endpoint: 'https://rpc.example', schedule }),
    ).rejects.toThrow('getProgramAccounts failed: -32603 too large');
  });
});

describe('sampling a program', () => {
  it('reads the chosen groups, scales by 256 / groups, and is repeatable with the same seed', async () => {
    // Every group holds exactly one account at the legacy minimum: the estimate must be exact, with no spread.
    const { options, calls } = fake(() => [account('OpenOrdersAccount', 200_000, 72)]);
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    expect(report.reliability).toBe('estimate');
    expect(report.total).toMatchObject({ accounts: 256, excessNow: 25_600_000n });
    expect(report.standardError).toBe(0n);
    const filters = calls
      // the sampled groups; the exact-size requests for short accounts have a test of their own
      .filter((call) => call.method === 'getProgramAccounts' && sizeAsked(call.params) === undefined)
      .map((call) => JSON.stringify(call.params[1]));
    expect(filters).toHaveLength(4);
    expect(new Set(filters).size).toBe(4);
    const again = fake(() => [account('OpenOrdersAccount', 200_000, 72)]);
    await sampleProgram(OPENBOOK, { ...again.options, offset: 8, buckets: 4, seed: 7 });
    expect(again.calls.map((call) => JSON.stringify(call.params))).toEqual(
      calls.map((call) => JSON.stringify(call.params)),
    );
  });

  it('judges every account type on its own: a good total does not vouch for a rare type', async () => {
    // OpenOrdersAccount occurs evenly; Market occurs in one group only.
    let group = 0;
    const { options } = fake(() => {
      group += 1;
      const even = Array.from({ length: 10 }, () => account('OpenOrdersAccount', 200_000, 72));
      return group === 1 ? [...even, account('Market', 200_000, 72)] : even;
    });
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    const byType = Object.fromEntries(report.buckets.map((bucket) => [bucket.type, bucket]));
    expect(report.reliability).toBe('estimate');
    expect(byType.OpenOrdersAccount).toMatchObject({ unreliable: false, standardError: 0n });
    expect(byType.Market?.unreliable).toBe(true);
    expect(byType.Market?.standardError).toBeGreaterThan(0n);
    expect(report.notes.join(' ')).toContain('missing from the report, not zero');
  });

  it('does not trust a zero: a rare type with no excess in the groups read, and a sample that found nothing', async () => {
    let group = 0;
    const { options } = fake(() => {
      group += 1;
      const even = Array.from({ length: 10 }, () => account('OpenOrdersAccount', 200_000, 72));
      // One Market at today's minimum: its excess is zero here, and says nothing about the other 255 groups.
      return group === 1 ? [...even, account('Market', 100_000, 72)] : even;
    });
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    const market = report.buckets.find((bucket) => bucket.type === 'Market');
    expect(market).toMatchObject({ excessNow: 0n, unreliable: true });

    const empty = fake(() => []);
    const nothing = await sampleProgram(OPENBOOK, { ...empty.options, offset: 8, buckets: 4, seed: 7 });
    expect(nothing.reliability).toBe('unreliable');
    expect(nothing.notes[0]).toContain('the groups read hold no accounts');
  });

  it('shows a large standard error when the groups are uneven', async () => {
    let group = 0;
    const { options } = fake(() => {
      group += 1;
      return group === 1 ? Array.from({ length: 50 }, () => account('Market', 200_000, 72)) : [];
    });
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    expect(report.standardError).toBeGreaterThan(report.total.excessNow / 2n);
    expect(report.reliability).toBe('unreliable');
    expect(report.notes[0]).toMatch(/^UNRELIABLE: /);
  });
});

describe('accounts too short to hold the sampled byte', () => {
  // The audit's fixture: one account of 8 bytes, one of 72, sampled by the byte at offset 40.
  const long = account('Market', 200_000, 72);
  const tiny = {
    pubkey: 'tiny',
    account: { lamports: 136_000, space: 8, data: [Buffer.alloc(8).toString('base64'), 'base64'] },
  };
  const byByte = (params: unknown[]) =>
    (params[1] as { filters: { memcmp: { bytes: string } }[] }).filters[0]?.memcmp.bytes === '1'
      ? [long]
      : [];

  it('are read by exact size and added unscaled: all groups plus the short sizes give the full scan', async () => {
    const { options, calls } = fake(byByte, 500n, (size) => (size === 8 ? [tiny] : []));
    const report = await sampleProgram('11111111111111111111111111111111', {
      ...options,
      offset: 40,
      buckets: 256,
      seed: 1,
    });
    expect(report.total).toMatchObject({ accounts: 2, excessNow: 168_000n });
    expect(report.reliability).toBe('estimate');
    const sizes = calls.map((call) =>
      call.method === 'getProgramAccounts' ? sizeAsked(call.params) : undefined,
    );
    expect(sizes.filter((size) => size !== undefined)).toEqual(Array.from({ length: 41 }, (_, size) => size));
    expect(report.method).toContain('41 exact-size requests');
  });

  it('are not scaled with the sample: with a fraction of the groups read, the short accounts count once', async () => {
    const { options } = fake(
      () => [long],
      500n,
      (size) => (size === 8 ? [tiny] : []),
    );
    const report = await sampleProgram('11111111111111111111111111111111', {
      ...options,
      offset: 40,
      buckets: 4,
      seed: 1,
    });
    // 4 groups with one long account each, scaled by 64, plus the one short account as it is
    expect(report.total).toMatchObject({ accounts: 257, excessNow: 256n * 100_000n + 68_000n });
  });

  it('are declared uncovered, and the result partial, when the offset is too far in to ask for every size', async () => {
    const { options, calls } = fake(() => [long]);
    const report = await sampleProgram('11111111111111111111111111111111', {
      ...options,
      offset: 300,
      buckets: 4,
      seed: 1,
    });
    expect(report.reliability).toBe('partial');
    expect(report.notes[0]).toContain('accounts of 300 bytes or fewer are not covered');
    expect(
      calls.some((call) => call.method === 'getProgramAccounts' && sizeAsked(call.params) !== undefined),
    ).toBe(false);
  });

  it('says what the standard error belongs to', async () => {
    const { options } = fake(() => [long]);
    const report = await sampleProgram('11111111111111111111111111111111', {
      ...options,
      offset: 40,
      buckets: 4,
      seed: 1,
    });
    expect(report.notes.join(' ')).toContain('The standard error belongs to excessNow of the sampled part');
  });
});

describe('scanning a wallet', () => {
  it('searches every owner-keyed type of the known programs by discriminator and owner', async () => {
    const { options, calls } = fake((params) =>
      JSON.stringify(params).includes(OPENBOOK) ? [account('OpenOrdersAccount', 200_000, 72)] : [],
    );
    const report = await scanWallet(WALLET, options);
    const searches = calls.filter((call) => call.method === 'getProgramAccounts');
    expect(searches).toHaveLength(4);
    for (const search of searches)
      expect(
        (search.params[1] as { filters: { memcmp: { bytes: string } }[] }).filters[1]?.memcmp.bytes,
      ).toBe(WALLET);
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toMatchObject({
      type: 'OpenBook v2: OpenOrdersAccount',
      closableBy: 'owner',
      excessNow: 100_000n,
    });
    expect(report.notes[0]).toContain('Token accounts and any other program are not covered');
    expect(report.notes[1]).toContain('github.com/drift-labs/protocol-v2 @ ');
  });

  it('refuses an invalid address before any request', async () => {
    const { options, calls } = fake(() => []);
    await expect(scanWallet('not-an-address', options)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('the transport', () => {
  it('repeats a request the endpoint answered with 429, and gives up after the allowed retries', async () => {
    let asked = 0;
    const server = createServer((_request, response) => {
      asked += 1;
      if (asked <= 2) response.writeHead(429).end();
      else response.writeHead(200, { 'content-type': 'application/json' }).end('{"result":"ok"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?api-key=secret`;
    try {
      expect(await rentRpc(url, { retryDelayMs: 1 })('getSlot', [])).toEqual({ result: 'ok' });
      expect(asked).toBe(3);
      asked = -10;
      await expect(rentRpc(url, { retryDelayMs: 1, retries: 2 })('getSlot', [])).rejects.toThrow(/HTTP 429/);
      await expect(rentRpc(url, { retryDelayMs: 1, retries: 0 })('getSlot', [])).rejects.not.toThrow(
        /secret/,
      );
    } finally {
      server.close();
    }
  });
});
