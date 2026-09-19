import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  address,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  lamports,
} from '@solana/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadPublisherKey } from '../../core/src/index.js';
import { sharedTestAdminKey, writeTestKey } from '../../core/test/keys.js';
import { buildProgram } from '../src/program.js';

const root = new URL('../../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-chain-'));
const versions = join(dir, 'versions');
const entries = join(dir, 'entries');
const publishers = join(dir, 'publishers.json');
// The registry config is a singleton: every on-chain suite acts as the same admin.
const adminKey = sharedTestAdminKey();
const publisherKey = writeTestKey(join(dir, 'publisher.json'));
let publisher: string;

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
  process.exitCode = undefined;
  await buildProgram().parseAsync(['node', 'epochnotes', ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

beforeAll(async () => {
  cpSync(`${root}registry/entries`, entries, { recursive: true });
  publisher = (await loadPublisherKey(publisherKey)).address;
  writeFileSync(
    publishers,
    JSON.stringify({ publishers: [{ name: 'test', key: publisher, status: 'active' }] }),
  );
  const rpc = createSolanaRpc('http://127.0.0.1:8899');
  const airdrop = airdropFactory({
    rpc,
    rpcSubscriptions: createSolanaRpcSubscriptions('ws://127.0.0.1:8900'),
  });
  for (const key of [adminKey, publisherKey]) {
    const recipientAddress = address((await loadPublisherKey(key)).address);
    await airdrop({ recipientAddress, lamports: lamports(2_000_000_000n), commitment: 'confirmed' });
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const publish = () =>
  run(
    'registry',
    'publish',
    '--key',
    publisherKey,
    '--entries',
    entries,
    '--versions',
    versions,
    '--uri',
    join(versions, '{root}.jsonl'),
  );
const verify = (...extra: string[]) =>
  run(
    'registry',
    'verify',
    'tx-v1',
    '--versions',
    versions,
    '--publishers',
    publishers,
    '--cluster',
    'localnet',
    ...extra,
  );

describe('epochnotes registry anchor / verify --onchain', () => {
  it('refuses to write to mainnet', async () => {
    const result = await run(
      'registry',
      'anchor',
      '--key',
      publisherKey,
      '--versions',
      versions,
      '--cluster',
      'mainnet-beta',
    );
    expect(result.code).toBe(2);
    expect(result.out).toContain('devnet and localnet only');
  });

  it('cannot anchor before the admin admits the publisher', async () => {
    expect((await publish()).code).toBe(0);
    const result = await run(
      'registry',
      'anchor',
      '--key',
      publisherKey,
      '--versions',
      versions,
      '--cluster',
      'localnet',
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain('is not registered on chain');
  });

  it('admits the publisher, anchors the log, and verifies an entry against the chain', async () => {
    const admitted = await run(
      'registry',
      'admit',
      '--admin-key',
      adminKey,
      '--publisher',
      publisher,
      '--name',
      'cli test',
      '--cluster',
      'localnet',
    );
    expect(admitted.code).toBe(0);
    expect(admitted.out).toMatch(/dmitted cli test on localnet/);

    // a key that is not the admin cannot admit anyone, itself included
    const stranger = await run(
      'registry',
      'admit',
      '--admin-key',
      publisherKey,
      '--publisher',
      publisher,
      '--name',
      'self',
      '--cluster',
      'localnet',
    );
    expect(stranger.code).toBe(2);

    const anchored = await run(
      'registry',
      'anchor',
      '--key',
      publisherKey,
      '--versions',
      versions,
      '--cluster',
      'localnet',
    );
    expect(anchored.code).toBe(0);
    expect(anchored.out).toMatch(/anchored version 1 {2}root [0-9a-f]{64}/);
    expect(
      (
        await run(
          'registry',
          'anchor',
          '--key',
          publisherKey,
          '--versions',
          versions,
          '--cluster',
          'localnet',
        )
      ).out,
    ).toContain('nothing to anchor');

    const verified = await verify('--onchain');
    expect(verified.code).toBe(0);
    expect(verified.out).toContain('1 version(s) match the localnet program');

    // version 2 exists off chain only: not anchored yet
    const entry = join(entries, 'tx-v1.yaml');
    writeFileSync(entry, readFileSync(entry, 'utf8').replace('rev: 1\n', 'rev: 2\n'));
    expect((await publish()).code).toBe(0);
    const ahead = await verify('--onchain');
    expect(ahead.code).toBe(1);
    expect(ahead.out).toContain('never anchored');
    expect(
      (
        await run(
          'registry',
          'anchor',
          '--key',
          publisherKey,
          '--versions',
          versions,
          '--cluster',
          'localnet',
        )
      ).code,
    ).toBe(0);
    expect((await verify('--onchain')).code).toBe(0);

    // a server that serves only version 1: signatures still verify, the chain says there are two
    const second = readFileSync(join(versions, '2.json'));
    rmSync(join(versions, '2.json'));
    expect((await verify()).code).toBe(0);
    const truncated = await verify('--onchain');
    expect(truncated.code).toBe(1);
    expect(truncated.out).toContain('rolled back or truncated');
    writeFileSync(join(versions, '2.json'), second);
  });
});
