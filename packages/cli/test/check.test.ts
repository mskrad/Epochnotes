import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { root, run, scratch } from './run.js';

const dir = scratch('check');

describe('epochnotes check repo', () => {
  const entries = `${root}registry/entries`;

  it('exits 1 when something is certain to break, and 0 on clean code', async () => {
    const broken = join(dir, 'repo-broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'a.ts'), 'getTransaction(sig, { maxSupportedTransactionVersion: 0 });\n');
    const found = await run('check', 'repo', broken, '--registry', entries);
    expect(found.code).toBe(1);
    expect(found.out).toMatch(/^BREAKS a\.ts:1 {2}\[tx-v1@1 rpc-max-version-zero\]/);

    const clean = join(dir, 'repo-clean');
    mkdirSync(clean);
    writeFileSync(join(clean, 'a.ts'), 'getTransaction(sig, { maxSupportedTransactionVersion: 1 });\n');
    expect((await run('check', 'repo', clean, '--registry', entries)).code).toBe(0);
  });

  it('prints JSON with --json and exits 2 when the path cannot be read', async () => {
    const report = await run('check', 'repo', join(dir, 'repo-broken'), '--registry', entries, '--json');
    expect(JSON.parse(report.out)).toMatchObject({ ok: true, findings: [{ file: 'a.ts', line: 1 }] });
    expect((await run('check', 'repo', join(dir, 'absent'), '--registry', entries)).code).toBe(2);
  });
});
