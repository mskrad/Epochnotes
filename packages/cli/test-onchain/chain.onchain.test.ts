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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadPublisherKey } from '../../core/src/index.js';
import { sharedTestAdminKey, writeTestKey } from '../../core/test/keys.js';
import { run } from '../test/run.js';

const root = new URL('../../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-chain-'));
const versions = join(dir, 'versions');
const entries = join(dir, 'entries');
const publishers = join(dir, 'publishers.json');
// The registry config is a singleton: every on-chain suite acts as the same admin.
const adminKey = sharedTestAdminKey();
const publisherKey = writeTestKey(join(dir, 'publisher.json'));
let publisher: string;

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

    // a key that is not the admin cannot admit anyone (a fresh key, so nothing else can be the reason)
    const fresh = (await loadPublisherKey(writeTestKey(join(dir, 'fresh.json')))).address;
    const stranger = await run(
      'registry',
      'admit',
      '--admin-key',
      publisherKey,
      '--publisher',
      fresh,
      '--name',
      'x',
      '--cluster',
      'localnet',
    );
    expect(stranger.code).toBe(2);
    expect(stranger.out).toContain('Custom program error: #6000'); // NotAdmin, not just any failure

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

    // the admin stops vouching for the publisher: clients refuse its whole log until it is restored
    const suspended = await run(
      'registry',
      'suspend',
      '--admin-key',
      adminKey,
      '--publisher',
      publisher,
      '--cluster',
      'localnet',
    );
    expect(suspended.code).toBe(0);
    const whileSuspended = await verify('--onchain');
    expect(whileSuspended.code).toBe(1);
    expect(whileSuspended.out).toContain('suspended by the registry admin');
    expect(
      (
        await run(
          'registry',
          'suspend',
          '--admin-key',
          publisherKey,
          '--publisher',
          publisher,
          '--cluster',
          'localnet',
        )
      ).out,
    ).toContain('#6000');
    const restored = await run(
      'registry',
      'restore',
      '--admin-key',
      adminKey,
      '--publisher',
      publisher,
      '--cluster',
      'localnet',
      '--json',
    );
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      publisher,
      active: true,
      signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/),
    });
    const refused = await run(
      'registry',
      'suspend',
      '--admin-key',
      publisherKey,
      '--publisher',
      publisher,
      '--cluster',
      'localnet',
      '--json',
    );
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('#6000') });
    expect((await verify('--onchain')).code).toBe(0);

    // the log is intact and anchored, and the entry is still withdrawn: a revocation is its own record on chain
    const unconfirmed = await run(
      'registry',
      'revoke',
      '--key',
      publisherKey,
      '--entry',
      'tx-v1',
      '--cluster',
      'localnet',
    );
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.out).toContain('--yes');
    expect((await verify('--onchain')).code).toBe(0); // nothing was revoked
    const revoked = await run(
      'registry',
      'revoke',
      '--key',
      publisherKey,
      '--entry',
      'tx-v1',
      '--cluster',
      'localnet',
      '--yes',
    );
    expect(revoked.code).toBe(0);
    const afterRevocation = await verify('--onchain');
    expect(afterRevocation.code).toBe(1);
    expect(afterRevocation.out).toContain('revoked on chain by its publisher (at version 2)');
    expect((await verify()).code).toBe(0); // without the chain, nothing tells the client
  });
});
