import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  decodeContent,
  encodeContent,
  GENESIS_ROOT,
  loadPublisherKey,
  type Manifest,
  publishVersion,
  readRawLog,
  validatePath,
  verifyEntry,
  verifyLog,
} from '../src/index.js';
import { writeTestKey } from './keys.js';

const liveEntries = new URL('../../../registry/entries', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'epochnotes-version-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir: string;
let entries: string;
let versions: string;
let keyFile: string;
let publisher: string;

beforeEach(async () => {
  dir = mkdtempSync(join(root, 'case-'));
  entries = join(dir, 'entries');
  versions = join(dir, 'versions');
  cpSync(liveEntries, entries, { recursive: true });
  keyFile = writeTestKey(join(dir, 'key.json'));
  publisher = (await loadPublisherKey(keyFile)).address;
});

const publish = (extra: { revoke?: string[] } = {}) =>
  publishVersion({
    entriesDir: entries,
    versionsDir: versions,
    keyFile,
    uri: join(versions, '{root}.jsonl'),
    published: '2026-09-18',
    ...extra,
  });
const verify = (entryId = 'tx-v1', trusted = [publisher]) =>
  verifyEntry({ versionsDir: versions, trustedPublishers: trusted, entryId });
const edit = (file: string, from: string | RegExp, to: string) => {
  const path = join(entries, file);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(from, to);
  if (after === before) throw new Error(`edit matched nothing in ${file}`);
  writeFileSync(path, after);
};
const manifestPath = (n: number) => join(versions, `${n}.json`);
const readManifest = (n: number) => JSON.parse(readFileSync(manifestPath(n), 'utf8')) as Manifest;
const messages = (result: { ok: boolean; issues?: { message: string }[] }) =>
  (result.issues ?? []).map((issue) => issue.message).join(' | ');

describe('publishing', () => {
  it('signs version 1 on the genesis root, and an entry verifies against it', async () => {
    const result = await publish();
    expect(result).toMatchObject({
      ok: true,
      published: true,
      manifest: { n: 1, prev_root: GENESIS_ROOT, entry_count: 4, publisher },
    });
    const verified = await verify();
    expect(verified).toMatchObject({ ok: true, versions: 1, proof: { entry: { id: 'tx-v1' } } });
  });

  it('is deterministic: the same entries give the same root and nothing new to publish', async () => {
    const first = await publish();
    const again = await publish();
    expect(again).toMatchObject({ ok: true, published: false });
    expect(readRawLog(versions)).toHaveLength(1);
    rmSync(versions, { recursive: true });
    const fresh = await publish();
    if (!first.ok || !fresh.ok) throw new Error('publish failed');
    expect(fresh.manifest.merkle_root).toBe(first.manifest.merkle_root);
  });

  it('chains version 2 to version 1 when an entry gets a new revision', async () => {
    const first = await publish();
    edit('tx-v1.yaml', 'rev: 1\n', 'rev: 2\n');
    edit('tx-v1.yaml', 'title: Transaction V1 Format', 'title: Transaction V1 Format (SIMD-0385)');
    const second = await publish();
    if (!first.ok || !second.ok) throw new Error(messages(second));
    expect(second.manifest).toMatchObject({ n: 2, prev_root: first.manifest.merkle_root });
    expect(await verify()).toMatchObject({
      ok: true,
      versions: 2,
      manifest: { n: 2 },
      proof: { entry: { rev: 2 } },
    });
  });

  it('writes nothing on a dry run', async () => {
    expect(
      await publishVersion({
        entriesDir: entries,
        versionsDir: versions,
        keyFile,
        uri: 'x',
        published: '2026-09-18',
        dryRun: true,
      }),
    ).toMatchObject({ ok: true, dryRun: true });
    expect(readRawLog(versions)).toEqual([]);
  });
});

describe('revision rules', () => {
  beforeEach(async () => void (await publish()));

  it('refuses a changed entry that keeps its rev', async () => {
    edit('tx-v1.yaml', 'title: Transaction V1 Format', 'title: Changed');
    expect(messages(await publish())).toContain('Content changed but rev is 1');
  });

  it('accepts a revision raised by exactly one, and refuses any other jump', async () => {
    edit('alpenglow.yaml', 'rev: 1\n', 'rev: 2\n');
    expect(await publish()).toMatchObject({ ok: true, manifest: { n: 2 } });
    edit('alpenglow.yaml', 'rev: 2\n', 'rev: 5\n');
    expect(messages(await publish())).toContain('rev is 5, published rev is 2');
    edit('alpenglow.yaml', 'rev: 5\n', 'rev: 1\n');
    expect(messages(await publish())).toContain('rev is 1, published rev is 2');
  });

  it('refuses a new entry that does not start at rev 1', async () => {
    writeFileSync(
      join(entries, 'new.yaml'),
      readFileSync(join(entries, 'tx-v1.yaml'), 'utf8')
        .replace('id: tx-v1', 'id: new-entry')
        .replace('rev: 1\n', 'rev: 3\n'),
    );
    expect(messages(await publish())).toContain('New entry starts at rev 3');
  });

  it('refuses a silently removed entry, and records a deliberate revocation', async () => {
    rmSync(join(entries, 'tx-v1.yaml'));
    expect(messages(await publish())).toContain('Published entry is missing');
    expect(await publish({ revoke: ['tx-v1'] })).toMatchObject({
      ok: true,
      manifest: { n: 2, entry_count: 3, revoked: ['tx-v1'] },
    });
    expect(messages(await verify('tx-v1'))).toContain('revoked by its publisher');
    expect(await verify('alpenglow')).toMatchObject({ ok: true });
  });

  it('refuses to revoke what is still present or was never published', async () => {
    expect(messages(await publish({ revoke: ['tx-v1'] }))).toContain('both revoked and still present');
    expect(messages(await publish({ revoke: ['nope'] }))).toContain('not in the previous version');
  });
});

describe('a client trusts nothing it has not checked', () => {
  beforeEach(async () => {
    await publish();
    edit('tx-v1.yaml', 'rev: 1\n', 'rev: 2\n');
    await publish();
  });

  const tamper = (n: number, change: (manifest: Manifest) => void) => {
    const manifest = readManifest(n);
    change(manifest);
    writeFileSync(manifestPath(n), JSON.stringify(manifest));
  };

  it('accepts the untouched log', async () => {
    expect(await verify()).toMatchObject({ ok: true, versions: 2 });
  });

  it.each([
    ['merkle_root', (m: Manifest) => void (m.merkle_root = 'ab'.repeat(32))],
    ['entry_count', (m: Manifest) => void (m.entry_count = 3)],
    ['uri', (m: Manifest) => void (m.uri = 'https://evil.example/content.jsonl')],
    ['published', (m: Manifest) => void (m.published = '2020-01-01')],
    ['revoked', (m: Manifest) => void (m.revoked = ['alpenglow'])],
  ])('rejects a manifest whose %s was changed after signing', async (_field, change) => {
    tamper(2, change);
    expect(messages(await verify())).toContain('Signature does not match');
  });

  it('rejects a log signed by a publisher it does not trust', async () => {
    expect(messages(await verify('tx-v1', ['11111111111111111111111111111111']))).toContain('is not trusted');
  });

  it('rejects a log with a removed version: the prev_root chain is broken', async () => {
    rmSync(manifestPath(1));
    cpSync(manifestPath(2), manifestPath(1));
    rmSync(manifestPath(2));
    const result = messages(await verify());
    expect(result).toContain('Manifest is numbered 2');
    expect(result).toContain('does not continue');
  });

  it('rejects a log whose versions were swapped', async () => {
    const [one, two] = [readFileSync(manifestPath(1)), readFileSync(manifestPath(2))];
    writeFileSync(manifestPath(1), two);
    writeFileSync(manifestPath(2), one);
    expect(messages(await verify())).toContain('does not continue');
  });

  it('rejects content with a single changed byte', async () => {
    const file = join(versions, `${readManifest(2).merkle_root}.jsonl`);
    const bytes = readFileSync(file);
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    writeFileSync(file, bytes);
    expect(messages(await verify())).toContain('No source served the committed content');
  });

  it('rejects the content of another version served in place of the latest', async () => {
    cpSync(
      join(versions, `${readManifest(1).merkle_root}.jsonl`),
      join(versions, `${readManifest(2).merkle_root}.jsonl`),
    );
    expect(messages(await verify())).toContain('hash_mismatch');
  });

  it('checks every manifest it is given, not only the last', async () => {
    const log = readRawLog(versions) as Manifest[];
    (log[0] as Manifest).entry_count = 9;
    const result = await verifyLog(log, [publisher]);
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain('Signature does not match');
  });
});

describe('content files', () => {
  const live = () => validatePath(liveEntries).files.flatMap((file) => (file.entry ? [file.entry] : []));

  it('round-trip, ordered by id whatever order the entries came in', () => {
    const content = encodeContent(live().reverse());
    expect(content.entries.map((entry) => entry.id)).toEqual([
      'alpenglow',
      'rent-simd-0437',
      'slot-duration',
      'tx-v1',
    ]);
    expect(decodeContent(content.bytes)).toMatchObject({ ok: true, content: { entries: content.entries } });
  });

  it('refuse a repeated entry, a reordered file, a non-canonical line and a truncated file', () => {
    const text = new TextDecoder().decode(encodeContent(live()).bytes);
    const lines = text.trimEnd().split('\n');
    const decode = (value: string) => messages(decodeContent(new TextEncoder().encode(value)) as never);
    expect(decode(`${text}${lines[3]}\n`)).toContain('out of order or repeated');
    expect(decode(`${[...lines].reverse().join('\n')}\n`)).toContain('out of order or repeated');
    expect(decode(`${(lines[0] ?? '').replace('{', '{ ')}\n`)).toContain('not in canonical form');
    expect(decode(text.trimEnd())).toContain('must end with a newline');
  });
});
