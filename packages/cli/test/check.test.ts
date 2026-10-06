import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
    // The first line says the rules were unsigned files; the findings follow.
    expect(found.out).toMatch(
      /^UNVERIFIED rules from the unsigned files in [^\n]+\nBREAKS a\.ts:1 {2}\[tx-v1@1 rpc-max-version-zero\]/,
    );

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

  it('prints nothing of a file that a link points to outside the repository, in either output form, and says it skipped it', async () => {
    const marker = 'OUTSIDE_THE_ROOT_MARKER';
    const outside = join(dir, 'outside.ts');
    writeFileSync(outside, `getTransaction(sig, { maxSupportedTransactionVersion: 0 }); // ${marker}\n`);
    const repo = join(dir, 'repo-link');
    mkdirSync(repo);
    symlinkSync(outside, join(repo, 'external.ts'));

    const json = await run('check', 'repo', repo, '--registry', entries, '--json');
    // The only file is a link that was not followed: nothing was read, which is exit 2, not a clean 0.
    expect(json.code).toBe(2);
    expect(json.out).not.toContain(marker);
    expect(JSON.parse(json.stdout)).toMatchObject({
      findings: [],
      skipped: [{ file: 'external.ts', reason: 'symlink-outside-root' }],
    });
    const prose = await run('check', 'repo', repo, '--registry', entries);
    expect(prose.out).not.toContain(marker);
    expect(prose.stdout).toContain('skipped: external.ts — symlink-outside-root');
    expect(prose.stdout).toContain('nothing was read');
  });

  it('exits 2, not 0, when it read no file: a directory git ignores, or one without any file a rule reads', async () => {
    const project = join(dir, 'ignored-project');
    mkdirSync(join(project, 'build'), { recursive: true });
    writeFileSync(join(project, '.gitignore'), 'build/\n');
    writeFileSync(
      join(project, 'build', 'reader.ts'),
      'getTransaction(sig, { maxSupportedTransactionVersion: 0 });\n',
    );
    execFileSync('git', ['-C', project, 'init', '-q']);
    const ignored = await run('check', 'repo', join(project, 'build'), '--registry', entries, '--json');
    expect(ignored.code).toBe(2);
    expect(JSON.parse(ignored.stdout)).toMatchObject({ filesScanned: 0, findings: [] });
    const other = join(dir, 'no-rule-files');
    mkdirSync(other);
    writeFileSync(join(other, 'Main.java'), 'class Main {}\n');
    const prose = await run('check', 'repo', other, '--registry', entries);
    expect(prose.code).toBe(2);
    expect(prose.stdout).toContain('nothing was read');
  });
});
