import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkRepository } from '../src/index.js';

const registry = new URL('../../../registry/entries', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'epochnotes-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Builds a throwaway repository from a map of relative paths to file contents. */
function repo(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function check(dir: string) {
  const report = checkRepository(dir, registry);
  if (!report.ok) throw new Error(JSON.stringify(report.issues));
  return report;
}

const before = `const tx = await connection.getTransaction(signature, {\n  commitment: 'confirmed',\n  maxSupportedTransactionVersion: 0,\n});\n`;
const after = before.replace('maxSupportedTransactionVersion: 0', 'maxSupportedTransactionVersion: 1');

describe('check repo', () => {
  it('finds the pinned version in the code before the fix, with the place, the rule and the fix', () => {
    const report = check(repo('before', { 'src/reader.ts': before }));
    expect(report.findings).toMatchObject([
      {
        entry: 'tx-v1',
        rule: 'rpc-max-version-zero',
        confidence: 'breaks',
        file: 'src/reader.ts',
        line: 3,
        excerpt: 'maxSupportedTransactionVersion: 0,',
      },
    ]);
    expect(report.findings[0]?.fix.join(' ')).toContain('maxSupportedTransactionVersion 1');
  });

  it('is silent on the code after the fix', () => {
    expect(check(repo('after', { 'src/reader.ts': after })).findings).toEqual([]);
  });

  it('does not mistake 0x…, 10 or a longer name for the literal 0', () => {
    const lookalikes = [
      'maxSupportedTransactionVersion: 0x1',
      'maxSupportedTransactionVersion: 10',
      'myMaxSupportedTransactionVersionDefault: 0 + 1',
    ];
    const report = check(
      repo('lookalikes', { 'a.ts': lookalikes.map((line) => `const o = { ${line} };`).join('\n') }),
    );
    expect(report.findings).toEqual([]);
  });

  it('asks to check a value that comes from a variable', () => {
    const report = check(
      repo('dynamic', { 'a.js': 'fetchTx({ maxSupportedTransactionVersion: config.version });\n' }),
    );
    expect(report.findings).toMatchObject([{ rule: 'rpc-max-version-dynamic', confidence: 'check' }]);
  });

  it('flags documentation that teaches the pattern, separately from code', () => {
    const report = check(
      repo('docs', {
        'docs/guide.md': '```json\n{ "maxSupportedTransactionVersion": 0 }\n```\n',
        'README.mdx': 'Use `maxSupportedTransactionVersion: 0`.\n',
      }),
    );
    expect(report.findings.map((finding) => [finding.file, finding.rule, finding.confidence])).toEqual([
      ['README.mdx', 'docs-teach-max-version-zero', 'check'],
      ['docs/guide.md', 'docs-teach-max-version-zero', 'check'],
    ]);
  });

  it('outside git, skips dependencies and other languages, but not a directory merely named build', () => {
    const report = check(
      repo('skipped', {
        'node_modules/x/index.ts': before,
        '.git/hooks/x.ts': before,
        'notes.txt': before,
        'skills/build/debug.md': 'Use `maxSupportedTransactionVersion: 0`.\n',
      }),
    );
    expect(report.findings.map((finding) => finding.file)).toEqual(['skills/build/debug.md']);
  });

  it('inside git, checks tracked files only', () => {
    const dir = repo('tracked', { 'src/a.ts': before, 'dist/a.js': before, '.gitignore': 'dist/\n' });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        stdio: 'ignore',
      });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    expect(check(dir).findings.map((finding) => finding.file)).toEqual(['src/a.ts']);
  });

  it.each([
    [
      'package-lock.json',
      JSON.stringify({
        packages: {
          'node_modules/@solana/kit': { version: '7.1.0' },
          'node_modules/a/node_modules/@solana/kit': { version: '8.3.0' },
        },
      }),
    ],
    [
      'yarn.lock',
      '"@solana/kit@^7.0.0":\n  version "7.1.0"\n  resolved "https://example"\n\n"@solana/kit@^8.0.0":\n  version "8.3.0"\n',
    ],
    [
      'pnpm-lock.yaml',
      "packages:\n  '@solana/kit@7.1.0':\n    resolution: {}\n  '@solana/kit@8.3.0(typescript@5.0.0)':\n    resolution: {}\n",
    ],
  ])('reads pinned versions from %s and flags only those below 8.0.0', (lockfile, text) => {
    const report = check(repo(`lock-${lockfile}`, { [lockfile]: text }));
    expect(report.findings.map((finding) => [finding.rule, finding.excerpt])).toEqual([
      ['kit-below-8', '@solana/kit@7.1.0'],
    ]);
  });

  it('says which rules it could not run', () => {
    expect(check(repo('empty', { 'a.ts': 'export {};\n' })).notRun).toMatchObject([
      { entry: 'tx-v1', rule: 'rpc-reads-v1-transaction' },
    ]);
  });
});
