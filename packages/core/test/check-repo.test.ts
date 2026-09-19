import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('flags a web3.js that cannot parse version 1 responses, and accepts one that can', () => {
    const lock = (version: string) =>
      JSON.stringify({ packages: { 'node_modules/@solana/web3.js': { version } } });
    expect(check(repo('web3-old', { 'package-lock.json': lock('1.98.4') })).findings).toMatchObject([
      { rule: 'web3js-below-1-99', excerpt: '@solana/web3.js@1.98.4' },
    ]);
    expect(check(repo('web3-new', { 'package-lock.json': lock('1.99.0') })).findings).toEqual([]);
  });

  describe('symbolic links', () => {
    const MARKER = 'OUTSIDE_THE_ROOT_MARKER';
    // A line that the tx-v1 rule matches, so that reading the file would show in the findings.
    const secret = `getTransaction(sig, { maxSupportedTransactionVersion: 0 }); // ${MARKER}\n`;
    const outside = repo('outside', { 'secret.ts': secret, 'dir/nested.ts': secret });
    const everywhere = (report: unknown) => JSON.stringify(report);

    it('outside git, never reads a file that a link points to outside the root, and says it skipped it', () => {
      const dir = repo('link-file', { 'own.ts': after });
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'external.ts'));
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.findings).toEqual([]);
      expect(report.skipped).toEqual([{ file: 'external.ts', reason: 'symlink-outside-root' }]);
    });

    it('inside git, where the link is a tracked file, the same', () => {
      const dir = repo('link-file-git', { 'own.ts': after });
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'external.ts'));
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.skipped).toEqual([{ file: 'external.ts', reason: 'symlink-outside-root' }]);
    });

    it('does not walk into a directory that a link points to outside the root', () => {
      const dir = repo('link-dir', { 'own.ts': after });
      symlinkSync(join(outside, 'dir'), join(dir, 'vendor'));
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.skipped).toEqual([{ file: 'vendor', reason: 'symlink-outside-root' }]);
    });

    it('ends on a cycle of directory links, and reads each real file once', () => {
      const dir = repo('link-cycle', { 'src/reader.ts': before });
      symlinkSync(dir, join(dir, 'src', 'loop'));
      symlinkSync(join(dir, 'src'), join(dir, 'again'));
      const report = check(dir);
      expect(report.findings.map((finding) => finding.file)).toEqual(['src/reader.ts']);
    });

    it('reads a link that stays inside the root once, under the real path', () => {
      const dir = repo('link-inside', { 'src/reader.ts': before });
      symlinkSync(join(dir, 'src', 'reader.ts'), join(dir, 'alias.ts'));
      const report = check(dir);
      expect(report.findings.map((finding) => finding.file)).toEqual(['src/reader.ts']);
      expect(report.skipped).toEqual([]);
    });

    it('works when the root itself is reached through a link', () => {
      const dir = repo('link-root-target', { 'reader.ts': before });
      symlinkSync(dir, join(root, 'link-root'));
      const report = check(join(root, 'link-root'));
      expect(report.findings.map((finding) => finding.file)).toEqual(['reader.ts']);
      expect(report.skipped).toEqual([]);
    });

    it('reports a dangling link instead of dropping it in silence', () => {
      const dir = repo('link-dangling', { 'own.ts': after });
      symlinkSync(join(dir, 'gone.ts'), join(dir, 'dangling.ts'));
      expect(check(dir).skipped).toEqual([{ file: 'dangling.ts', reason: 'broken-symlink' }]);
    });
  });

  it('says which rules it could not run', () => {
    expect(check(repo('empty', { 'a.ts': 'export {};\n' })).notRun).toMatchObject([
      { entry: 'tx-v1', rule: 'rpc-reads-v1-transaction' },
    ]);
  });
});
