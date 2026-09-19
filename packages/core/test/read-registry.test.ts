import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { type FeatureAccountSource, publishVersion, readRegistry } from '../src/index.js';
import { writeTestKey } from './keys.js';

const entries = new URL('../../../registry/entries', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-read-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const versions = join(dir, 'versions');
const keyFile = writeTestKey(join(dir, 'key.json'));
const nothingScheduled: FeatureAccountSource = {
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
      'rent-simd-0437',
      'slot-duration',
      'tx-v1',
    ]);
    expect(reading.entries.every((item) => item.gates === undefined)).toBe(true);
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

  it('attaches what the network says about every gate, with the cluster and the slot', async () => {
    const reading = await readRegistry({
      log: { versionsDir: versions, trustedPublishers: [publisher] },
      ids: ['rent-simd-0437'],
      status: { cluster: 'testnet', source: nothingScheduled },
    });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.network).toEqual({ cluster: 'testnet', slot: '7' });
    expect(reading.entries[0]?.gates).toHaveLength(5);
    expect(reading.entries[0]?.gates?.every((gate) => gate.status.state === 'absent')).toBe(true);
  });

  it('fails, rather than guess a status, when the cluster does not answer', async () => {
    const down: FeatureAccountSource = { getAccounts: () => Promise.reject(new Error('fetch failed')) };
    await expect(
      readRegistry({
        log: { versionsDir: versions, trustedPublishers: [publisher] },
        status: { cluster: 'testnet', source: down },
      }),
    ).rejects.toThrow('cluster testnet did not answer: fetch failed');
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
    expect(reading.entries).toHaveLength(4);
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
