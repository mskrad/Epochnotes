import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // Runs after the revocation above: tx-v1 is withdrawn on chain, the other entries are not.
  describe('a consumer after the revocation', () => {
    const source = ['--versions', versions, '--publishers', publishers];
    const chain = ['--onchain', '--cluster', 'localnet'];
    const title = 'Transaction V1 Format';

    it('is refused the revoked entry it asked for: exit 1, and not a word of the entry', async () => {
      const read = await run('registry', 'read', 'tx-v1', ...source, ...chain, '--json');
      expect(read.code).toBe(1);
      const answer = JSON.parse(read.stdout) as { ok: boolean; issues: { message: string }[] };
      expect(answer.ok).toBe(false);
      expect(answer.issues[0]?.message).toContain('revoked on chain by its publisher (at version 2)');
      expect(read.out).not.toContain(title);
    });

    it('gets the other entries, with the revoked one named apart and absent from the entries', async () => {
      const read = await run('registry', 'read', ...source, ...chain, '--json');
      expect(read.code).toBe(0);
      const reading = JSON.parse(read.stdout) as {
        provenance: { revocations: string };
        entries: { entry: { id: string } }[];
        revoked: { id: string; atVersion: number; address: string }[];
      };
      expect(reading.provenance.revocations).toBe('checked');
      expect(reading.entries.map(({ entry }) => entry.id)).toEqual([
        'alpenglow',
        'eip-7702',
        'rent-simd-0437',
        'slot-duration',
      ]);
      expect(reading.revoked).toEqual([{ id: 'tx-v1', atVersion: 2, address: expect.any(String) }]);
      expect(read.out).not.toContain(title);

      const prose = await run('registry', 'read', ...source, ...chain);
      expect(prose.out).toContain('tx-v1: REVOKED on chain');
      expect(prose.out).not.toContain(title);
    });

    it('shows the revoked entry only when asked to include it, and marks it', async () => {
      const read = await run('registry', 'read', 'tx-v1', ...source, ...chain, '--include-revoked', '--json');
      expect(read.code).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({
        entries: [{ entry: { id: 'tx-v1' }, revokedOnChain: true }],
        revoked: [{ id: 'tx-v1' }],
      });
    });

    it('says that revocations were not checked when the chain was not asked', async () => {
      const read = await run('registry', 'read', 'tx-v1', ...source, '--json');
      expect(read.code).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({
        provenance: { chain: 'not-checked', revocations: 'not-checked' },
      });
      expect((await run('registry', 'read', 'tx-v1', ...source)).out).toContain('revocations not checked');
    });

    it('does not run the rules of the revoked entry against a repository', async () => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      writeFileSync(join(repo, 'reader.ts'), 'getTransaction(sig, { maxSupportedTransactionVersion: 0 });\n');
      // A file the remaining entries do read: with tx-v1 withdrawn, the check still reads something, so its
      // silence is about the withdrawn rules, not about an empty scan (which would exit 2).
      writeFileSync(join(repo, 'Vault.sol'), 'contract Vault {}\n');
      const unchecked = await run('check', 'repo', repo, ...source, '--json');
      expect(unchecked.code).toBe(1);
      expect(JSON.parse(unchecked.stdout)).toMatchObject({ findings: [{ entry: 'tx-v1' }] });

      const checked = await run('check', 'repo', repo, ...source, ...chain, '--json');
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        provenance: { revocations: 'checked' },
        filesScanned: 1,
        findings: [],
        revoked: [{ id: 'tx-v1' }],
      });
    });

    it('refuses to measure rent with a revoked entry as the schedule, before any request to the measured cluster', async () => {
      const scan = await run(
        ...['rent', 'scan', '--program', 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb', '--entry', 'tx-v1'],
        ...[
          ...source,
          '--onchain',
          '--registry-cluster',
          'localnet',
          '--rpc-url',
          'http://127.0.0.1:1',
          '--json',
        ],
      );
      expect(scan.code).toBe(1);
      const answer = JSON.parse(scan.stdout) as { ok: boolean; issues: { message: string }[] };
      expect(answer.ok).toBe(false);
      expect(answer.issues[0]?.message).toContain('revoked on chain by its publisher');
    });

    it('does not contradict itself when asked to include the revoked entry', async () => {
      const prose = await run('registry', 'read', 'tx-v1', ...source, ...chain, '--include-revoked');
      expect(prose.out).toContain('shown above because you asked to include it');
      expect(prose.out).not.toContain('not used');
    });

    it('does not probe an endpoint with the rules of the revoked entry, and does not call that a pass', async () => {
      const args = [
        ...['check', 'rpc', '--rpc-url', 'http://127.0.0.1:8899', ...source],
        ...['--onchain', '--registry-cluster', 'localnet'],
      ];
      const probe = await run(...args, '--json');
      expect(JSON.parse(probe.stdout)).toMatchObject({ probes: [], revoked: [{ id: 'tx-v1' }] });
      // The only entry with a probe was withdrawn, so this run observed nothing: exit 0 would read as
      // "the endpoint was checked and is fine".
      expect(probe.code).toBe(2);
      const prose = await run(...args);
      expect(prose.stdout).toContain('no entry of this version carries a probe to run');
    });
  });
});
