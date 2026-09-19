import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeTestKey } from '../../core/test/keys.js';
import { root, run, scratch } from './run.js';

const dir = scratch('versions');

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
