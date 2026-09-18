import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { writeTestKey } from '../../core/test/keys.js';
import { buildProgram } from '../src/program.js';

const root = new URL('../../../', import.meta.url).pathname;

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

const reference = readFileSync(`${root}registry/entries/tx-v1.yaml`, 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-cli-'));

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('epochnotes registry publish / verify', () => {
  const versions = join(dir, 'versions');
  const key = writeTestKey(join(dir, 'publisher-key.json'));
  const publishers = join(dir, 'publishers.json');
  const entries = `${root}registry/entries`;

  it('publishes a version, then proves an entry against it', async () => {
    const published = await run(
      'registry',
      'publish',
      '--key',
      key,
      '--entries',
      entries,
      '--versions',
      versions,
      '--uri',
      join(versions, '{root}.jsonl'),
      '--json',
    );
    expect(published.code).toBe(0);
    const { manifest } = JSON.parse(published.out) as { manifest: { publisher: string; n: number } };
    expect(manifest.n).toBe(1);
    writeFileSync(
      publishers,
      JSON.stringify({ publishers: [{ name: 'test', key: manifest.publisher, status: 'active' }] }),
    );

    const verified = await run(
      'registry',
      'verify',
      'tx-v1',
      '--versions',
      versions,
      '--publishers',
      publishers,
    );
    expect(verified.code).toBe(0);
    expect(verified.out).toMatch(/^OK {4}tx-v1@1 is in version 1 of /);
  });

  it('remembers a version through --pin: accepts the same log, refuses a shorter one and a malformed pin', async () => {
    const seen = await run('registry', 'verify', 'tx-v1', '--versions', versions, '--publishers', publishers);
    const pin = /pin {7}(\d+:[0-9a-f]{64})/.exec(seen.out)?.[1] ?? '';
    expect(pin).toMatch(/^1:/);
    expect(
      (
        await run(
          'registry',
          'verify',
          'tx-v1',
          '--versions',
          versions,
          '--publishers',
          publishers,
          '--pin',
          pin,
        )
      ).code,
    ).toBe(0);

    const ahead = await run(
      'registry',
      'verify',
      'tx-v1',
      '--versions',
      versions,
      '--publishers',
      publishers,
      '--pin',
      pin.replace(/^1:/, '2:'),
    );
    expect(ahead.code).toBe(1);
    expect(ahead.out).toContain('version 2 was seen before');
    expect(
      (
        await run(
          'registry',
          'verify',
          'tx-v1',
          '--versions',
          versions,
          '--publishers',
          publishers,
          '--pin',
          'latest',
        )
      ).code,
    ).toBe(2);
  });

  it('exits 1 for an unknown entry, an untrusted publisher and a tampered manifest', async () => {
    expect(
      (await run('registry', 'verify', 'no-such-entry', '--versions', versions, '--publishers', publishers))
        .code,
    ).toBe(1);

    const nobody = join(dir, 'nobody.json');
    writeFileSync(nobody, JSON.stringify({ publishers: [] }));
    const untrusted = await run(
      'registry',
      'verify',
      'tx-v1',
      '--versions',
      versions,
      '--publishers',
      nobody,
    );
    expect(untrusted.code).toBe(1);
    expect(untrusted.out).toContain('is not trusted');

    const manifestFile = join(versions, '1.json');
    writeFileSync(
      manifestFile,
      readFileSync(manifestFile, 'utf8').replace('"entry_count": 4', '"entry_count": 5'),
    );
    const tampered = await run(
      'registry',
      'verify',
      'tx-v1',
      '--versions',
      versions,
      '--publishers',
      publishers,
    );
    expect(tampered.code).toBe(1);
    expect(tampered.out).toContain('Signature does not match');
  });

  it('exits 2 when the key file cannot be read', async () => {
    expect(
      (
        await run(
          'registry',
          'publish',
          '--key',
          join(dir, 'absent.json'),
          '--entries',
          entries,
          '--versions',
          versions,
        )
      ).code,
    ).toBe(2);
  });
});

describe('epochnotes status', () => {
  it('exits 2 and says what to do when the cluster does not answer', async () => {
    const { code, out } = await run(
      'status',
      '--registry',
      `${root}registry/entries`,
      '--rpc-url',
      'http://127.0.0.1:9',
    );
    expect(code).toBe(2);
    expect(out).toContain('did not answer');
    expect(out).toContain('--rpc-url');
  });

  it('rejects a cluster name it does not know', async () => {
    await expect(run('status', '--cluster', 'localnet')).rejects.toThrow();
  });
});

describe('epochnotes registry validate', () => {
  it('exits 0 on the reference entry and prints its leaf', async () => {
    const { code, out } = await run('registry', 'validate', `${root}registry/entries/tx-v1.yaml`);
    expect(code).toBe(0);
    expect(out).toMatch(/^OK .*tx-v1@1 {2}leaf [0-9a-f]{64}$/);
  });

  it('exits 0 on the whole entries directory', async () => {
    expect((await run('registry', 'validate', `${root}registry/entries`)).code).toBe(0);
  });

  it('exits 1 on a broken entry and says how to fix it', async () => {
    const file = join(dir, 'broken.yaml');
    writeFileSync(file, reference.replace('axis: protocol\n', 'axis: protocol\nstatus: active\n'));
    const { code, out } = await run('registry', 'validate', file);
    rmSync(file);
    expect(code).toBe(1);
    expect(out).toContain('fix: Remove it: activation status is never stored in an entry');
  });

  it('resolves relations of a single file against the entries next to it', async () => {
    const entry = join(dir, 'tx-v1.yaml');
    writeFileSync(
      entry,
      reference.replace('relations: []', 'relations:\n  - type: requires\n    id: slot-duration'),
    );
    const alone = await run('registry', 'validate', entry);
    expect(alone.code).toBe(1);
    expect(alone.out).toContain('No entry with id "slot-duration"');
    expect(alone.out).not.toMatch(/^OK /m);

    writeFileSync(join(dir, 'slot-duration.yaml'), 'id: slot-duration\n');
    const besideInvalid = await run('registry', 'validate', entry);
    expect(besideInvalid.code).toBe(1);
    expect(besideInvalid.out).toContain('Ignored as invalid');
    expect(besideInvalid.out).toContain('slot-duration.yaml');

    writeFileSync(join(dir, 'slot-duration.yaml'), reference.replace('id: tx-v1', 'id: slot-duration'));
    expect((await run('registry', 'validate', entry)).code).toBe(0);
    expect((await run('registry', 'validate', dir)).code).toBe(0);
  });

  it('exits 2 when the path cannot be read', async () => {
    expect((await run('registry', 'validate', `${root}no-such-file.yaml`)).code).toBe(2);
  });

  it('prints machine-readable JSON with --json', async () => {
    const { out } = await run('registry', 'validate', '--json', `${root}registry/entries/tx-v1.yaml`);
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: [{ id: 'tx-v1', rev: 1 }] });
    expect(Object.keys(JSON.parse(out).files[0]).sort()).toEqual([
      'file',
      'id',
      'issues',
      'leaf',
      'ok',
      'rev',
    ]);
  });
});
