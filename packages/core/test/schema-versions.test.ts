import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  activationsOf,
  buildVersion,
  type Entry,
  loadPublisherKey,
  probeOf,
  probeRpc,
  publishVersion,
  readRegistry,
  signManifest,
  SOLANA_CHAINS,
  subjectOf,
  validateEntry,
  validatePath,
} from '../src/index.js';
import { writeTestKey } from './keys.js';

const v1Dir = new URL('./fixtures/schema-v1', import.meta.url).pathname;
const v2Dir = new URL('../../../registry/entries', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-schemas-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function entriesIn(path: string): Entry[] {
  const report = validatePath(path);
  if (!report.ok) throw new Error(JSON.stringify(report));
  return report.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
}

const issuesOf = (raw: unknown) => {
  const result = validateEntry(raw);
  return result.ok ? [] : result.issues;
};

/** A minimal schema-2 entry, for one kind of activation at a time. */
function v2With(activations: unknown[]): Record<string, unknown> {
  return {
    schema_version: 2,
    id: 'sample',
    rev: 1,
    axis: 'protocol',
    subject: { standard: 'eip', name: 'EIP-0000', title: 'Sample' },
    applies: { activations },
    breaks: [{ surface: 'program', summary: 'Something changes.' }],
    fix: [{ summary: 'Do something.' }],
    sources: [{ kind: 'proposal', ref: 'https://example.invalid/eip', retrieved: '2026-10-02' }],
  };
}

/**
 * Signs a log the way the publisher did before schema 2, which it no longer does: build, sign, then the content
 * file and the manifest next to it.
 */
async function signAsBefore(entries: Entry[], versions: string, keyFile: string) {
  const key = await loadPublisherKey(keyFile);
  const built = buildVersion({
    entries,
    publisher: key.address,
    uri: join(versions, '{root}.jsonl'),
    published: '2026-09-20',
  });
  if (!built.ok || built.unchanged) throw new Error(JSON.stringify(built));
  const manifest = await signManifest(built.manifest, key.privateKey);
  mkdirSync(versions, { recursive: true });
  writeFileSync(join(versions, `${manifest.merkle_root}.jsonl`), built.content.bytes);
  writeFileSync(join(versions, '1.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

describe('a version signed in schema 1', () => {
  const versions = join(dir, 'v1-log');
  const keyFile = writeTestKey(join(dir, 'v1-key.json'));

  it('verifies with the reader of schema 2, under the root it was signed with', async () => {
    const manifest = await signAsBefore(entriesIn(v1Dir), versions, keyFile);
    // The root of the four schema-1 entries that every log signed between 2026-09-20 and 2026-10-02 holds.
    expect(manifest.merkle_root).toBe('fa7d2f5fc66c67bf2ea200014283346620cb5953a7475ad2385d11fff5a4471e');
    const reading = await readRegistry({
      log: { versionsDir: versions, trustedPublishers: [manifest.publisher] },
    });
    if (!reading.ok) throw new Error(JSON.stringify(reading.issues));
    expect(reading.provenance).toMatchObject({ verified: true, version: 1 });
    expect(reading.entries.map(({ entry }) => entry.schema_version)).toEqual([1, 1, 1, 1]);
    expect(readdirSync(versions).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
  });

  it('is not signed again: the publisher refuses a schema-1 entry, and names what to do', async () => {
    const refused = await publishVersion({
      entriesDir: v1Dir,
      versionsDir: join(dir, 'refused'),
      keyFile,
      uri: '{root}.jsonl',
      published: '2026-10-02',
      dryRun: true,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.issues).toHaveLength(4);
    expect(refused.issues[0]).toMatchObject({
      path: 'alpenglow: schema_version',
      message: 'Entry is in schema_version 1, which is read but no longer published',
      hint: expect.stringMatching(/Move it to schema_version 2\. If this log already holds it, raise rev/),
    });
  });

  it('moves on to schema 2 in the same log only with rev raised, since its content changes', async () => {
    const same = await publishVersion({
      entriesDir: v2Dir,
      versionsDir: versions,
      keyFile,
      uri: join(versions, '{root}.jsonl'),
      published: '2026-10-02',
      dryRun: true,
    });
    expect(same.ok).toBe(false);
    if (same.ok) throw new Error('unreachable');
    expect(same.issues.map((issue) => issue.message).join(' ')).toMatch(/Content changed but rev is 1/);
  });
});

describe('one entry, two schemas', () => {
  const v1 = new Map(entriesIn(v1Dir).map((entry) => [entry.id, entry]));
  const v2 = new Map(entriesIn(v2Dir).map((entry) => [entry.id, entry]));

  it.each([...v1.keys()])('%s reads the same through the view in either schema', (id) => {
    const old = v1.get(id);
    const now = v2.get(id);
    if (old === undefined || now === undefined) throw new Error(`${id} is missing`);
    expect(old.schema_version).toBe(1);
    expect(now.schema_version).toBe(2);
    // The migration changed the form only: same id and rev, same subject, activations, claims and sources.
    expect(now.rev).toBe(old.rev);
    expect(subjectOf(now)).toEqual(subjectOf(old));
    expect(activationsOf(now)).toEqual(activationsOf(old));
    for (const field of ['axis', 'relations', 'breaks', 'fix', 'sources'] as const)
      expect(now[field], field).toEqual(old[field]);
    // A probe fixture names its chain by CAIP-2 now; everything else about the rules is unchanged.
    // A probe is compared as the engine runs it (schema 1 named only its method), less the spelling of its chain.
    const fixtureless = (entry: Entry) =>
      entry.detect.map((rule) =>
        rule.kind === 'runtime-probe'
          ? { ...rule, probe: { ...probeOf(rule.probe), fixture: undefined } }
          : rule,
      );
    expect(fixtureless(now)).toEqual(fixtureless(old));
  });

  it('a schema-1 fixture and its schema-2 form point at the same transaction on the same cluster', async () => {
    const fixtures = (entry: Entry | undefined) =>
      (entry?.detect ?? []).flatMap((rule) => (rule.kind === 'runtime-probe' ? [rule.probe.fixture] : []));
    const old = fixtures(v1.get('tx-v1'))[0] ?? '';
    const now = fixtures(v2.get('tx-v1'))[0] ?? '';
    expect(old.split(':')[0]).toBe('mainnet-beta');
    expect(now).toBe(`${SOLANA_CHAINS['mainnet-beta']}:${old.split(':')[1]}`);
    // And the probe takes both to the same endpoint, and to no other.
    const calls: string[] = [];
    const mainnet = async (method: string) => {
      calls.push(method);
      return method === 'getGenesisHash'
        ? { result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }
        : { result: { version: 1 } };
    };
    for (const entry of [v1.get('tx-v1'), v2.get('tx-v1')]) {
      const report = await probeRpc('https://rpc.example', entry === undefined ? [] : [entry], mainnet);
      expect(report.probes.map((probe) => probe.verdict)).toEqual(['reads']);
    }
    const devnet = async () => ({ result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
    for (const entry of [v1.get('tx-v1'), v2.get('tx-v1')]) {
      const report = await probeRpc('https://rpc.example', entry === undefined ? [] : [entry], devnet);
      expect(report.probes.map((probe) => probe.verdict)).toEqual(['not-applicable']);
    }
  });
});

describe('activations in schema 2', () => {
  const featureAccount = {
    kind: 'feature-account',
    chain: 'solana',
    address: 'txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL',
    label: 'enable_tx_v1',
  };
  const fork = { kind: 'timestamp', chain: 'eip155:1', at: 1746612311, label: 'prague' };
  const height = {
    kind: 'block-height',
    chain: 'bip122:000000000019d6689c085ae165831e93',
    at: 1,
    label: 'x',
  };

  it('accepts each kind, and several chains for one change', () => {
    expect(issuesOf(v2With([featureAccount]))).toEqual([]);
    expect(issuesOf(v2With([fork, { ...fork, chain: 'eip155:56', label: 'pascal' }]))).toEqual([]);
    expect(issuesOf(v2With([{ ...fork, evidence: { header: 'requestsHash' } }]))).toEqual([]);
    expect(issuesOf(v2With([height]))).toEqual([]);
  });

  it('refuses an activation on a chain its kind cannot be read on', () => {
    const cases: [string, unknown][] = [
      ['a fork time on Solana', { ...fork, chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }],
      ['a fork time on a namespace alone', { ...fork, chain: 'eip155' }],
      ['a feature account on an EVM chain', { ...featureAccount, chain: 'eip155:1' }],
      ['a feature account pinned to one cluster', { ...featureAccount, chain: SOLANA_CHAINS.devnet }],
      ['a block height on Solana', { ...height, chain: SOLANA_CHAINS['mainnet-beta'] }],
      ['a block height on a chain that is not CAIP-2', { ...height, chain: 'bitcoin' }],
      ['a fractional time', { ...fork, at: 1.5 }],
      ['a feature address that is not base58', { ...featureAccount, address: '0x00' }],
      ['an activation that states its own status', { ...fork, active: true }],
    ];
    for (const [name, activation] of cases)
      expect(
        issuesOf(v2With([activation]))
          .map((issue) => issue.path)
          .join(),
        name,
      ).toMatch(/^applies\.activations\[0\]/);
  });

  it('names the format it does not know, instead of failing on some field', () => {
    for (const [version, message] of [
      [3, 'Unsupported schema_version 3'],
      ['2', 'Unsupported schema_version "2"'],
      [undefined, 'Missing schema_version'],
    ] as const) {
      const raw = { ...v2With([fork]), schema_version: version };
      expect(issuesOf(raw), String(version)).toMatchObject([
        { path: 'schema_version', message, hint: expect.stringMatching(/knows schema_version 1 and 2/) },
      ]);
    }
  });

  it('reads a schema-1 gate as a feature account of the Solana namespace', () => {
    const old = parse(
      'schema_version: 1\nid: x\nrev: 1\naxis: protocol\nsubject: { type: simd, name: SIMD-0000, title: X }\n' +
        'applies:\n  gates:\n    - address: txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL\n      label: enable_tx_v1\n' +
        'breaks: [{ surface: rpc, summary: s }]\nfix: [{ summary: f }]\n' +
        "sources: [{ kind: simd, ref: r, retrieved: '2026-09-18' }]\n",
    ) as unknown;
    const result = validateEntry(old);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(activationsOf(result.entry)).toEqual([featureAccount]);
    expect(subjectOf(result.entry)).toEqual({ standard: 'simd', name: 'SIMD-0000', title: 'X' });
  });
});

describe('a probe as data', () => {
  const probeEntry = (probe: Record<string, unknown>) => ({
    ...v2With([{ kind: 'timestamp', chain: 'eip155:1', at: 1, label: 'x' }]),
    detect: [{ rule: 'sample-probe', kind: 'runtime-probe', confidence: 'check', summary: 's', probe }],
  });
  const good = {
    fixture: `eip155:1:0x${'ab'.repeat(32)}`,
    calls: [{ id: 'transaction', method: 'eth_getTransactionByHash', params: ['$fixture'] }],
    observe: ['result.type'],
    pass: [{ call: 'transaction', path: 'result.type', equals: '0x4' }],
    expect: 'Type 4.',
  };

  it('accepts a probe that names its calls, what to record and when it passes', () => {
    expect(issuesOf(probeEntry(good))).toEqual([]);
  });

  it('refuses a probe the engine could not run or could not judge', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        'a call without an id',
        { ...good, calls: [{ method: 'eth_getTransactionByHash', params: ['$fixture'] }] },
        /probe\.calls\[0\]\.id/,
      ],
      [
        'a pass on a call that does not exist',
        { ...good, pass: [{ call: 'receipt', path: 'result.type', equals: '0x4' }] },
        /probe\.pass\[0\]\.call/,
      ],
      ['two calls with one id', { ...good, calls: [...good.calls, ...good.calls] }, /probe\.calls\[1\]\.id/],
      [
        'no call that reads the fixture',
        { ...good, calls: [{ id: 'transaction', method: 'eth_blockNumber', params: [] }] },
        /probe\.calls$/,
      ],
      [
        'a fixture on a chain no endpoint is identified as',
        { ...good, fixture: `eip155:10:0x${'ab'.repeat(32)}` },
        /probe\.fixture/,
      ],
      [
        'an EVM fixture with a Solana signature',
        { ...good, fixture: `eip155:1:${'1'.repeat(88)}` },
        /probe\.fixture/,
      ],
      ['a path outside the answer', { ...good, observe: ['params.0'] }, /probe\.observe\[0\]/],
      ['no pass condition', { ...good, pass: [] }, /probe\.pass/],
      ['the schema-1 form', { method: 'getTransaction', fixture: good.fixture, expect: 'x' }, /probe/],
      [
        'a call that writes',
        { ...good, calls: [{ id: 'transaction', method: 'eth_sendRawTransaction', params: ['$fixture'] }] },
        /probe\.calls\[0\]\.method/,
      ],
      [
        'a call that simulates',
        { ...good, calls: [{ id: 'transaction', method: 'simulateTransaction', params: ['$fixture'] }] },
        /probe\.calls\[0\]\.method/,
      ],
    ];
    for (const [name, probe, path] of cases)
      expect(
        issuesOf(probeEntry(probe))
          .map((issue) => issue.path)
          .join(' '),
        name,
      ).toMatch(path);
  });
});
