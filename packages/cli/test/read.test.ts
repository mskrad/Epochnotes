import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { writeTestKey } from '../../core/test/keys.js';
import { root, run, scratch } from './run.js';

const dir = scratch('read');

describe('epochnotes registry read / check rpc', () => {
  const versions = join(dir, 'versions');
  const key = writeTestKey(join(dir, 'publisher-key.json'));
  const publishers = join(dir, 'publishers.json');
  const entries = `${root}registry/entries`;
  const source = ['--versions', versions, '--publishers', publishers];
  const nowhere = 'http://127.0.0.1:1';

  it('prints the entries of the verified version with their provenance', async () => {
    const published = await run(
      ...['registry', 'publish', '--key', key, '--entries', entries, '--versions', versions],
      ...['--uri', join(versions, '{root}.jsonl'), '--json'],
    );
    expect(published.code).toBe(0);
    const { manifest } = JSON.parse(published.out) as {
      manifest: { publisher: string; merkle_root: string };
    };
    writeFileSync(
      publishers,
      JSON.stringify({ publishers: [{ name: 'test', key: manifest.publisher, status: 'active' }] }),
    );

    const read = await run('registry', 'read', 'tx-v1', ...source, '--json');
    expect(read.code).toBe(0);
    const reading = JSON.parse(read.stdout) as {
      provenance: Record<string, unknown>;
      entries: { entry: { id: string; sources: unknown[] } }[];
    };
    expect(reading.provenance).toMatchObject({
      verified: true,
      version: 1,
      publisher: manifest.publisher,
      merkleRoot: manifest.merkle_root,
    });
    expect(reading.entries.map(({ entry }) => entry.id)).toEqual(['tx-v1']);
    expect(reading.entries[0]?.entry.sources.length).toBeGreaterThan(0);
  });

  it('exits 1 for an id the version does not have, and still says so as JSON', async () => {
    const read = await run('registry', 'read', 'no-such-entry', ...source, '--json');
    expect(read.code).toBe(1);
    expect(JSON.parse(read.stdout)).toMatchObject({ entries: [], unknownIds: ['no-such-entry'] });
  });

  it('marks unsigned files as unverified in both output forms', async () => {
    const prose = await run('registry', 'read', 'tx-v1', '--working-copy', entries);
    expect(prose.code).toBe(0);
    expect(prose.stdout).toMatch(/^UNVERIFIED working copy /);
    const json = await run('registry', 'read', 'tx-v1', '--working-copy', entries, '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ provenance: { verified: false } });
  });

  it('exits 2 when the cluster asked for the status does not answer', async () => {
    const read = await run(
      ...['registry', 'read', ...source, '--status', 'localnet'],
      '--status-rpc-url',
      nowhere,
      '--json',
    );
    expect(read.code).toBe(2);
    const answer = JSON.parse(read.stdout) as { ok: boolean; error: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('cluster localnet did not answer');
  });

  it('treats a request for the chain that cannot be honoured as a usage error, exit 2, for every consumer command', async () => {
    const program = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
    const cases: [string[], string][] = [
      [['registry', 'read', '--working-copy', entries, '--onchain'], '--onchain needs the signed log'],
      [
        ['check', 'rpc', '--rpc-url', nowhere, '--working-copy', entries, '--onchain'],
        '--onchain needs the signed log',
      ],
      [
        ['rent', 'scan', '--program', program, '--working-copy', entries, '--onchain'],
        '--onchain needs the signed log',
      ],
      [['registry', 'read', ...source, '--include-revoked'], '--include-revoked needs --onchain'],
    ];
    for (const [args, reason] of cases) {
      const result = await run(...args, '--json');
      expect(result.code, args.join(' ')).toBe(2);
      expect((JSON.parse(result.stdout) as { error: string }).error).toContain(reason);
    }
  });

  it('exits 2 when the probed endpoint does not answer', async () => {
    const probe = await run('check', 'rpc', '--rpc-url', nowhere, ...source, '--json');
    expect(probe.code).toBe(2);
    expect(JSON.parse(probe.stdout)).toMatchObject({ probes: [{ verdict: 'unreachable' }] });
  });

  it('requires the endpoint to probe: a usage error, exit 2', async () => {
    const probe = await run('check', 'rpc', ...source);
    expect(probe.code).toBe(2);
    expect(probe.stderr).toContain("required option '--rpc-url <url>' not specified");
  });

  it('checks a repository with the rules of the verified version, and says which version', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    writeFileSync(
      join(repo, 'reader.ts'),
      'getTransaction(signature, { maxSupportedTransactionVersion: 0 });\n',
    );
    const checked = await run('check', 'repo', repo, ...source, '--json');
    expect(checked.code).toBe(1);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      provenance: { verified: true, version: 1 },
      findings: [{ entry: 'tx-v1', rule: 'rpc-max-version-zero', file: 'reader.ts' }],
    });
  });

  it('labels a repository check that used unsigned rules, in both output forms', async () => {
    const repo = join(dir, 'repo');
    const json = await run('check', 'repo', repo, '--registry', entries, '--json');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ provenance: { verified: false, workingCopy: entries } });
    const prose = await run('check', 'repo', repo, '--registry', entries);
    expect(prose.stdout).toMatch(/^UNVERIFIED rules from the unsigned files in /);
  });

  it('exits 2, not 1, when the log path does not exist or is empty', async () => {
    for (const where of [join(dir, 'absent'), '']) {
      const read = await run('registry', 'read', '--versions', where, '--publishers', publishers, '--json');
      expect(read.code).toBe(2);
      expect((JSON.parse(read.stdout) as { error: string }).error).toContain('there is no version log at');
    }
    const verified = await run(
      ...['registry', 'verify', 'tx-v1', '--versions', join(dir, 'absent')],
      ...['--publishers', publishers, '--json'],
    );
    expect(verified.code).toBe(2);
    expect((JSON.parse(verified.stdout) as { error: string }).error).toContain('there is no version log at');
  });

  it('takes the log and the publishers from the environment when no option names them', async () => {
    vi.stubEnv('EPOCHNOTES_VERSIONS', versions);
    vi.stubEnv('EPOCHNOTES_PUBLISHERS', publishers);
    try {
      const read = await run('registry', 'read', 'tx-v1', '--json');
      expect(read.code).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ provenance: { verified: true, version: 1 } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Last: it damages the published content.
  it('prints no entry from a version whose content was tampered with, and exits 1', async () => {
    const file = join(versions, readdirSync(versions).find((name) => name.endsWith('.jsonl')) ?? '');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, before.replace('-32015', '-32016'));
    expect(readFileSync(file, 'utf8')).not.toBe(before);
    for (const args of [
      ['registry', 'read', 'tx-v1'],
      ['check', 'rpc', '--rpc-url', nowhere],
      ['check', 'repo', join(dir, 'repo')],
    ]) {
      const result = await run(...args, ...source, '--json');
      expect(result.code).toBe(1);
      const answer = JSON.parse(result.stdout) as { ok: boolean; issues: unknown[] };
      expect(answer.ok).toBe(false);
      expect(answer.issues.length).toBeGreaterThan(0);
      expect(result.out).not.toContain('SIMD-0385');
    }
  });
});
