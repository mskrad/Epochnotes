import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  type ChainSource,
  checkDirectory,
  CLUSTER_GENESIS,
  type Issue,
  type OnchainRevocation,
  publishVersion,
  type ReadOptions,
  readRegistry,
  SOLANA_CHAINS,
  solanaActivationReader,
  type SolanaReadSource,
} from '../src/index.js';
import { writeTestKey } from './keys.js';

const entries = new URL('../../../registry/entries', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-read-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const versions = join(dir, 'versions');
const keyFile = writeTestKey(join(dir, 'key.json'));
const nothingScheduled: SolanaReadSource = {
  getGenesisHash: async () => CLUSTER_GENESIS.testnet,
  getAccounts: async (addresses) => ({ slot: 7n, accounts: addresses.map(() => null) }),
};

describe('reading the registry for a consumer', () => {
  let publisher = '';

  it('returns the entries of the latest verified version and says which version that is', async () => {
    const published = await publishVersion({
      entriesDir: entries,
      versionsDir: versions,
      keyFile,
      uri: join(versions, '{root}.jsonl'),
      published: '2026-09-18',
    });
    if (!published.ok) throw new Error(JSON.stringify(published.issues));
    publisher = published.manifest.publisher;

    const reading = await readRegistry({ log: { versionsDir: versions, trustedPublishers: [publisher] } });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.provenance).toMatchObject({
      verified: true,
      publisher,
      version: 1,
      merkleRoot: published.manifest.merkle_root,
      chain: 'not-checked',
    });
    expect(reading.entries.map(({ entry }) => entry.id)).toEqual([
      'alpenglow',
      'eip-7702',
      'rent-simd-0437',
      'slot-duration',
      'tx-v1',
    ]);
    expect(reading.entries.every((item) => item.activations === undefined)).toBe(true);
  });

  it('narrows to the ids asked for and names the ones the version does not have', async () => {
    const reading = await readRegistry({
      log: { versionsDir: versions, trustedPublishers: [publisher] },
      ids: ['tx-v1', 'no-such-entry'],
    });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.entries.map(({ entry }) => entry.id)).toEqual(['tx-v1']);
    expect(reading.unknownIds).toEqual(['no-such-entry']);
  });

  it('attaches what the network says about every activation, with the chain and the point of the reading', async () => {
    const reading = await readRegistry({
      log: { versionsDir: versions, trustedPublishers: [publisher] },
      ids: ['rent-simd-0437'],
      status: { reader: solanaActivationReader(nothingScheduled), chain: SOLANA_CHAINS.testnet },
    });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.network).toEqual({
      chain: SOLANA_CHAINS.testnet,
      name: 'testnet',
      identifiedBy: 'genesis',
      point: { slot: '7' },
    });
    expect(reading.entries[0]?.activations).toHaveLength(5);
    expect(reading.entries[0]?.activations?.every((item) => item.status.state === 'absent')).toBe(true);
    expect(reading.entries[0]).not.toHaveProperty('noActivation');
  });

  it('names an entry that has no activation on the chain asked about, instead of showing it bare', async () => {
    const copy = join(dir, 'with-evm');
    cpSync(entries, copy, { recursive: true });
    writeFileSync(
      join(copy, 'sample-fork.yaml'),
      'schema_version: 2\nid: sample-fork\nrev: 1\naxis: protocol\nsubject: { standard: eip, name: EIP-0000, title: S }\n' +
        "applies:\n  activations:\n    - { kind: timestamp, chain: 'eip155:1', at: 1, label: s }\n" +
        'breaks: [{ surface: program, summary: s }]\nfix: [{ summary: f }]\n' +
        "sources: [{ kind: proposal, ref: r, retrieved: '2026-10-02' }]\n",
    );
    const reading = await readRegistry({
      workingCopy: copy,
      ids: ['sample-fork', 'tx-v1'],
      status: { reader: solanaActivationReader(nothingScheduled), chain: SOLANA_CHAINS.testnet },
    });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    const [fork, txV1] = reading.entries;
    expect(fork).toMatchObject({
      entry: { id: 'sample-fork' },
      activations: [],
      noActivation: 'no activation on this chain; it activates on eip155:1',
    });
    expect(txV1?.activations).toHaveLength(1);
    expect(txV1).not.toHaveProperty('noActivation');
  });

  it('fails, rather than guess a status, when the cluster does not answer', async () => {
    const down: SolanaReadSource = {
      getGenesisHash: () => Promise.reject(new Error('fetch failed')),
      getAccounts: () => Promise.reject(new Error('fetch failed')),
    };
    await expect(
      readRegistry({
        log: { versionsDir: versions, trustedPublishers: [publisher] },
        status: { reader: solanaActivationReader(down), chain: SOLANA_CHAINS.testnet },
      }),
    ).rejects.toThrow(`cannot read chain ${SOLANA_CHAINS.testnet}: fetch failed`);
  });

  it('treats a log that is not there as a broken environment, not as a failed verification', async () => {
    await expect(
      readRegistry({ log: { versionsDir: join(dir, 'absent'), trustedPublishers: [publisher] } }),
    ).rejects.toThrow('there is no version log at');
  });

  it('labels unsigned files as unverified', async () => {
    const reading = await readRegistry({ workingCopy: entries });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.provenance).toMatchObject({ verified: false, workingCopy: entries });
    expect(reading.entries).toHaveLength(5);
  });

  it('gives no entries from a publisher that is not trusted', async () => {
    const reading = await readRegistry({
      log: { versionsDir: versions, trustedPublishers: ['11111111111111111111111111111111'] },
    });
    expect(reading.ok).toBe(false);
    expect(reading).not.toHaveProperty('entries');
  });

  // Last: it damages the published content.
  it('gives no entries when the content of the version was tampered with', async () => {
    const content = readdirSync(versions).find((name) => name.endsWith('.jsonl')) ?? '';
    const file = join(versions, content);
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, before.replace('-32015', '-32016'));
    expect(readFileSync(file, 'utf8')).not.toBe(before);
    const reading = await readRegistry({ log: { versionsDir: versions, trustedPublishers: [publisher] } });
    expect(reading.ok).toBe(false);
    expect(reading).not.toHaveProperty('entries');
    if (reading.ok) throw new Error('unreachable');
    expect(reading.issues.map((issue) => issue.message).join(' ')).toMatch(/hash|content/i);
  });
});

describe('entries the publisher withdrew', () => {
  const work = join(dir, 'withdrawn');
  const log = join(work, 'versions');
  const copy = join(work, 'entries');
  const key = writeTestKey(join(dir, 'withdrawn-key.json'));
  let signer = '';
  const record = {
    address: 'RevocationAccount1111111111111111111111111111',
    entryId: 'tx-v1',
    atVersion: 1n,
  };
  const chainWith = (revokedIds: string[], differences: Issue[] = []): ChainSource => ({
    differences: async () => differences,
    revocation: async (_publisher, entryId) =>
      revokedIds.includes(entryId) ? ({ ...record, entryId } as OnchainRevocation) : undefined,
  });
  const publish = (revoke?: string[]) =>
    publishVersion({
      entriesDir: copy,
      versionsDir: log,
      keyFile: key,
      uri: join(log, '{root}.jsonl'),
      published: '2026-09-19',
      ...(revoke === undefined ? {} : { revoke }),
    });
  const read = (extra: Partial<ReadOptions> = {}) =>
    readRegistry({ log: { versionsDir: log, trustedPublishers: [signer] }, ...extra });

  it('says that revocations were not checked when the chain was not asked', async () => {
    cpSync(entries, copy, { recursive: true });
    const published = await publish();
    if (!published.ok) throw new Error(JSON.stringify(published.issues));
    signer = published.manifest.publisher;
    const reading = await read();
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.provenance).toMatchObject({ chain: 'not-checked', revocations: 'not-checked' });
    expect(reading.revoked).toEqual([]);
  });

  it('leaves an entry revoked on chain out of the entries and names it apart', async () => {
    const reading = await read({ chain: chainWith(['tx-v1']) });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.provenance).toMatchObject({ chain: 'matches', revocations: 'checked' });
    expect(reading.entries.map(({ entry }) => entry.id)).toEqual([
      'alpenglow',
      'eip-7702',
      'rent-simd-0437',
      'slot-duration',
    ]);
    expect(reading.revoked).toEqual([{ id: 'tx-v1', atVersion: 1, address: record.address }]);
    expect(JSON.stringify(reading)).not.toContain('Transaction V1 Format');
  });

  it('refuses a revoked entry asked for by name, in the words of verify, and returns no entry at all', async () => {
    const reading = await read({ ids: ['tx-v1', 'alpenglow'], chain: chainWith(['tx-v1']) });
    expect(reading).toEqual({
      ok: false,
      issues: [
        {
          path: 'tx-v1',
          message: 'Entry was revoked on chain by its publisher (at version 1)',
          hint: `Do not rely on this entry. The revocation account is ${record.address}.`,
        },
      ],
    });
  });

  it('finds a revocation of an entry that was not asked for: what is built on the reading needs it', async () => {
    const reading = await read({ ids: ['alpenglow'], chain: chainWith(['tx-v1']) });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.entries.map(({ entry }) => entry.id)).toEqual(['alpenglow']);
    expect(reading.revoked.map(({ id }) => id)).toEqual(['tx-v1']);
  });

  it('returns a revoked entry only when told to include it, and marks it', async () => {
    const reading = await read({ ids: ['tx-v1'], chain: chainWith(['tx-v1']), includeRevoked: true });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.entries).toHaveLength(1);
    expect(reading.entries[0]).toMatchObject({ entry: { id: 'tx-v1' }, revokedOnChain: true });
    const others = await read({ chain: chainWith(['tx-v1']), includeRevoked: true });
    if (!others.ok) throw new Error(JSON.stringify(others.issues));
    expect(others.entries.filter((item) => item.revokedOnChain).map(({ entry }) => entry.id)).toEqual([
      'tx-v1',
    ]);
  });

  it('filters by entry, not wholesale: with another entry revoked, the rules of tx-v1 still run', async () => {
    const reading = await read({ chain: chainWith(['alpenglow']) });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    const repo = join(work, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'reader.ts'), 'getTransaction(sig, { maxSupportedTransactionVersion: 0 });\n');
    const usable = reading.entries.map(({ entry }) => entry);
    expect(checkDirectory(repo, usable).findings.map((finding) => finding.entry)).toEqual(['tx-v1']);
    const withdrawn = await read({ chain: chainWith(['tx-v1']) });
    if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn.issues));
    expect(
      checkDirectory(
        repo,
        withdrawn.entries.map(({ entry }) => entry),
      ).findings,
    ).toEqual([]);
  });

  it('names an unknown id too when it refuses a revoked one', async () => {
    const reading = await read({ ids: ['tx-v1', 'no-such'], chain: chainWith(['tx-v1']) });
    if (reading.ok) throw new Error('must be refused');
    expect(reading.issues.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'tx-v1: Entry was revoked on chain by its publisher (at version 1)',
      'no-such: No such entry in this version',
    ]);
  });

  it('never lets a request for the chain pass in silence', async () => {
    await expect(readRegistry({ workingCopy: entries, chain: chainWith([]) })).rejects.toThrow(
      '--onchain needs the signed log',
    );
    await expect(read({ includeRevoked: true })).rejects.toThrow('--include-revoked needs --onchain');
  });

  it('returns nothing when the log disagrees with the chain', async () => {
    const difference = { path: 'log', message: 'rolled back or truncated', hint: 'x' };
    expect(await read({ chain: chainWith([], [difference]) })).toEqual({ ok: false, issues: [difference] });
  });

  it('fails, rather than treat the entry as not revoked, when the chain does not answer', async () => {
    const down: ChainSource = {
      differences: async () => [],
      revocation: () => Promise.reject(new Error('fetch failed')),
    };
    await expect(read({ chain: down })).rejects.toThrow('fetch failed');
  });

  it('never returns an entry withdrawn in the signed log itself', async () => {
    rmSync(join(copy, 'rent-simd-0437.yaml'));
    const second = await publish(['rent-simd-0437']);
    if (!second.ok) throw new Error(JSON.stringify(second.issues));
    expect(second.manifest.revoked).toContain('rent-simd-0437');
    const reading = await read();
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.provenance).toMatchObject({ version: 2 });
    expect(reading.entries.map(({ entry }) => entry.id)).toEqual([
      'alpenglow',
      'eip-7702',
      'slot-duration',
      'tx-v1',
    ]);
    expect(await read({ ids: ['rent-simd-0437'] })).toMatchObject({
      ok: true,
      entries: [],
      unknownIds: ['rent-simd-0437'],
    });
  });
});
