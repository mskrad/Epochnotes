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

function fake(accounts: (params: unknown[]) => unknown, rate = 500n) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: RentRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getAccountInfo') return { result: sysvar(rate) };
    return { result: accounts(params) };
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

/**
 * One population of accounts behind an RPC that applies the filters the way a node does: memcmp compares the
 * byte at the offset (an account too short for it matches nothing), dataSize compares the size exactly.
 */
interface Member {
  type: string;
  lamports: number;
  space: number;
  /** The byte at the sampled offset; ignored when the account is too short to have one. */
  byte: number;
}
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const byteOf = (base58: string) =>
  [...base58].reduce((value, char) => value * 58 + ALPHABET.indexOf(char), 0);

function population(members: Member[], { ignoresDataSize = false, rate = 500n } = {}) {
  const calls: { offset?: number; byte?: number; size?: number }[] = [];
  const rpc: RentRpc = async (method, params) => {
    if (method === 'getAccountInfo') return { result: sysvar(rate) };
    const config = params[1] as {
      withContext?: boolean;
      filters?: { memcmp?: { offset: number; bytes: string }; dataSize?: number }[];
    };
    const filter = config.filters?.[0];
    const matching = members.filter((member) => {
      if (filter?.memcmp !== undefined)
        return member.space > filter.memcmp.offset && member.byte === byteOf(filter.memcmp.bytes);
      if (filter?.dataSize !== undefined) return ignoresDataSize || member.space === filter.dataSize;
      return true;
    });
    if (filter?.memcmp !== undefined)
      calls.push({ offset: filter.memcmp.offset, byte: byteOf(filter.memcmp.bytes) });
    if (filter?.dataSize !== undefined) calls.push({ size: filter.dataSize });
    const value = matching.map((member) => account(member.type, member.lamports, member.space));
    return { result: config.withContext ? { context: { slot: 11 }, value } : value };
  };
  return { calls, options: { rpc, gates, endpoint: 'https://rpc.example', schedule } };
}

/** `count` accounts at the legacy minimum (100 000 above today's), one in each of the byte values given. */
const spread = (type: string, bytes: number[]): Member[] =>
  bytes.map((byte) => ({ type, lamports: 200_000, space: 72, byte }));
const everyByte = Array.from({ length: 256 }, (_, byte) => byte);
const UNKNOWN = '11111111111111111111111111111111';

describe('sampling a program', () => {
  it('reads three groups always and a seeded choice of the others, and scales only what was left to chance', async () => {
    const { options, calls } = population(spread('OpenOrdersAccount', everyByte));
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    // one account in every group: 3 read for certain, 253 estimated from 4
    expect(report.total).toMatchObject({ accounts: 256, excessNow: 25_600_000n });
    expect(report).toMatchObject({ reliability: 'estimate', standardError: 0n });
    const groups = calls.filter((call) => call.byte !== undefined).map((call) => call.byte);
    expect(groups.slice(0, 3)).toEqual([0, 1, 255]);
    expect(new Set(groups).size).toBe(7);
    const again = population(spread('OpenOrdersAccount', everyByte));
    await sampleProgram(OPENBOOK, { ...again.options, offset: 8, buckets: 4, seed: 7 });
    expect(again.calls).toEqual(calls);
    const other = population(spread('OpenOrdersAccount', everyByte));
    await sampleProgram(OPENBOOK, { ...other.options, offset: 8, buckets: 4, seed: 8 });
    expect(other.calls).not.toEqual(calls);
  });

  it('gives the full scan when every group is read, whatever the spread', async () => {
    const members = [...spread('Market', [0, 0, 0, 9, 200]), ...spread('OpenOrdersAccount', [1, 77, 255])];
    const full = await scanProgram(OPENBOOK, population(members).options);
    const sample = await sampleProgram(OPENBOOK, {
      ...population(members).options,
      offset: 8,
      buckets: 256,
      seed: 1,
    });
    expect(sample.total).toEqual(full.total);
    expect(sample.standardError).toBe(0n);
  });

  it('counts a type piled onto a zero byte exactly, which no spread of other groups could have revealed', async () => {
    // 568 accounts with a zero at the offset, as OpenBook v2 has at offset 40; the rest spread evenly
    const piled = spread('BookSide', Array(568).fill(0) as number[]);
    const { options } = population([...piled, ...spread('OpenOrdersAccount', everyByte)]);
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 8, seed: 3 });
    const byType = Object.fromEntries(report.buckets.map((bucket) => [bucket.type, bucket]));
    expect(byType.BookSide).toMatchObject({
      accounts: 568,
      excessNow: 56_800_000n,
      standardError: 0n,
      unreliable: false,
    });
    expect(report.total.accounts).toBe(568 + 256);
    expect(report.reliability).toBe('estimate');
  });

  it('judges every account type on its own: a good total does not vouch for a rare type', async () => {
    // seed 7 draws byte 77 first among the sampled groups: the only Market sits there
    const probe = population(spread('OpenOrdersAccount', everyByte));
    await sampleProgram(OPENBOOK, { ...probe.options, offset: 8, buckets: 4, seed: 7 });
    const drawn = probe.calls.map((call) => call.byte).filter((byte) => byte !== undefined)[3] as number;
    const { options } = population([
      ...spread(
        'OpenOrdersAccount',
        everyByte.flatMap((byte) => Array(10).fill(byte) as number[]),
      ),
      ...spread('Market', [drawn]),
    ]);
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    const byType = Object.fromEntries(report.buckets.map((bucket) => [bucket.type, bucket]));
    expect(report.reliability).toBe('estimate');
    expect(byType.OpenOrdersAccount).toMatchObject({ unreliable: false, standardError: 0n });
    expect(byType.Market?.unreliable).toBe(true);
    expect(byType.Market?.standardError).toBeGreaterThan(0n);
    expect(report.notes.join(' ')).toContain('missing from the report, not zero');
  });

  it('shows a large standard error, and says unreliable, when the sampled groups are uneven', async () => {
    const probe = population(spread('Market', everyByte));
    await sampleProgram(OPENBOOK, { ...probe.options, offset: 8, buckets: 4, seed: 7 });
    const drawn = probe.calls.map((call) => call.byte).filter((byte) => byte !== undefined)[3] as number;
    const { options } = population(spread('Market', Array(50).fill(drawn) as number[]));
    const report = await sampleProgram(OPENBOOK, { ...options, offset: 8, buckets: 4, seed: 7 });
    expect(report.standardError).toBeGreaterThan(report.total.excessNow / 2n);
    expect(report.reliability).toBe('unreliable');
    expect(report.notes[0]).toMatch(/^UNRELIABLE: /);
  });

  it('does not trust an empty sample, whatever was read in full beside it', async () => {
    // fifty accounts in a group that is not drawn, one in a group that is always read, one too short for any group
    const probe = population(spread('Market', everyByte));
    await sampleProgram(UNKNOWN, { ...probe.options, offset: 40, buckets: 4, seed: 7 });
    const read = new Set(probe.calls.map((call) => call.byte));
    const unread = everyByte.find((byte) => !read.has(byte)) as number;
    const members = [
      ...spread('Market', Array(50).fill(unread) as number[]),
      ...spread('Market', [0]),
      { type: 'Market', lamports: 136_000, space: 8, byte: 0 },
    ];
    const report = await sampleProgram(UNKNOWN, {
      ...population(members).options,
      offset: 40,
      buckets: 4,
      seed: 7,
    });
    expect(report.total.accounts).toBe(2);
    expect(report.reliability).toBe('unreliable');
    expect(report.notes[0]).toContain(
      'the sampled groups hold no accounts, which says nothing about the groups that were not read',
    );
  });
});

describe('accounts too short to hold the sampled byte', () => {
  // The audit's fixture: one account of 8 bytes, one of 72 with a zero at offset 40.
  const audit: Member[] = [
    { type: 'Market', lamports: 136_000, space: 8, byte: 0 },
    { type: 'Market', lamports: 200_000, space: 72, byte: 0 },
  ];

  it('are read by exact size: every group plus the short sizes give the full scan (the audit case)', async () => {
    const { options, calls } = population(audit);
    const full = await scanProgram(UNKNOWN, population(audit).options);
    const report = await sampleProgram(UNKNOWN, { ...options, offset: 40, buckets: 256, seed: 1 });
    expect(full.total).toMatchObject({ accounts: 2, excessNow: 168_000n });
    expect(report.total).toEqual(full.total);
    expect(report.reliability).toBe('estimate');
    expect(calls.filter((call) => call.size !== undefined).map((call) => call.size)).toEqual(
      Array.from({ length: 41 }, (_, size) => size),
    );
    expect(report.method).toContain('41 exact-size request(s) for accounts of 40 bytes or fewer');
  });

  it('draw the line where the byte begins: 40 bytes is short, 41 bytes is in a group, and nothing is counted twice', async () => {
    const members: Member[] = [
      { type: 'Market', lamports: 200_000, space: 40, byte: 5 },
      { type: 'Market', lamports: 200_000, space: 41, byte: 5 },
    ];
    const full = await scanProgram(UNKNOWN, population(members).options);
    const report = await sampleProgram(UNKNOWN, {
      ...population(members).options,
      offset: 40,
      buckets: 256,
      seed: 1,
    });
    expect(report.total).toEqual(full.total);
    expect(report.total.accounts).toBe(2);
  });

  it('are not scaled with the sample: with a fraction of the groups read, they count once', async () => {
    const { options } = population([
      ...spread('Market', everyByte),
      { type: 'Market', lamports: 136_000, space: 8, byte: 0 },
    ]);
    const report = await sampleProgram(UNKNOWN, { ...options, offset: 40, buckets: 4, seed: 1 });
    expect(report.total).toMatchObject({ accounts: 257, excessNow: 256n * 100_000n + 68_000n });
  });

  it('are declared uncovered, and the result partial, when the offset is too far in to ask for every size', async () => {
    const { options, calls } = population(
      spread('Market', everyByte).map((member) => ({ ...member, space: 400 })),
    );
    const report = await sampleProgram(UNKNOWN, { ...options, offset: 300, buckets: 4, seed: 1 });
    expect(report.reliability).toBe('partial');
    expect(report.notes[0]).toContain('accounts of 300 bytes or fewer are not covered');
    expect(report.method).toContain('NOT covered');
    expect(calls.some((call) => call.size !== undefined)).toBe(false);
    const edge = await sampleProgram(UNKNOWN, {
      ...population(spread('Market', everyByte).map((member) => ({ ...member, space: 400 }))).options,
      offset: 128,
      buckets: 4,
      seed: 1,
    });
    expect(edge.reliability).toBe('estimate');
  });

  it('counts nothing from an endpoint that ignores the size filter, and says the result is partial', async () => {
    const members = [
      ...spread('Market', everyByte),
      { type: 'Market', lamports: 136_000, space: 8, byte: 0 },
    ];
    const honest = await sampleProgram(UNKNOWN, {
      ...population(members).options,
      offset: 40,
      buckets: 4,
      seed: 1,
    });
    const report = await sampleProgram(UNKNOWN, {
      ...population(members, { ignoresDataSize: true }).options,
      offset: 40,
      buckets: 4,
      seed: 1,
    });
    expect(report.reliability).toBe('partial');
    expect(report.total.accounts).toBe(honest.total.accounts - 1);
    expect(report.notes.join(' ')).toContain('does not apply the dataSize filter');
  });

  it('says what the standard error belongs to, and that the reads are not of one slot', async () => {
    const report = await sampleProgram(UNKNOWN, {
      ...population(spread('Market', everyByte)).options,
      offset: 40,
      buckets: 4,
      seed: 1,
    });
    expect(report.notes.join(' ')).toContain('The standard error belongs to excessNow of the sampled part');
    expect(report.notes.join(' ')).toContain('answered at different slots');
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
