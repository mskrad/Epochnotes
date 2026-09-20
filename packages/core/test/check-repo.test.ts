import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkDirectory, checkRepository, validatePath } from '../src/index.js';

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

const canLink = (() => {
  try {
    symlinkSync(root, join(root, 'probe-link'));
    rmSync(join(root, 'probe-link'));
    return true;
  } catch {
    return false;
  }
})();

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

  // Creating a link needs a privilege on some systems; without it these tests say so instead of failing.
  describe.skipIf(!canLink)('symbolic links (skipped where this user cannot create them)', () => {
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

    it('inside git, a link does not widen the scan to an ignored or untracked file of the repository', () => {
      const dir = repo('link-ignored', { '.gitignore': '.env.ts\n', 'own.ts': after });
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);
      git('init', '-q');
      writeFileSync(join(dir, '.env.ts'), secret);
      writeFileSync(join(dir, 'scratch.ts'), secret);
      symlinkSync(join(dir, '.env.ts'), join(dir, 'env-alias.ts'));
      symlinkSync(join(dir, 'scratch.ts'), join(dir, 'scratch-alias.ts'));
      git('add', '.gitignore', 'own.ts', 'env-alias.ts', 'scratch-alias.ts');
      git('commit', '-q', '-m', 'init');
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.skipped).toEqual([
        { file: 'env-alias.ts', reason: 'symlink-target-not-scanned' },
        { file: 'scratch-alias.ts', reason: 'symlink-target-not-scanned' },
      ]);
    });

    it('outside git, a link does not lead into a directory that is left out by name', () => {
      const dir = repo('link-dependencies', { 'own.ts': after, 'node_modules/pkg/x.ts': secret });
      symlinkSync(join(dir, 'node_modules', 'pkg', 'x.ts'), join(dir, 'file-alias.ts'));
      symlinkSync(join(dir, 'node_modules', 'pkg'), join(dir, 'dir-alias'));
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.skipped).toEqual([
        { file: 'dir-alias', reason: 'symlink-target-not-scanned' },
        { file: 'file-alias.ts', reason: 'symlink-target-not-scanned' },
      ]);
    });

    it('resolves a link whatever it is called: one named node_modules that leaves the root is reported', () => {
      const dir = repo('link-named-dependencies', { 'own.ts': after });
      symlinkSync(join(outside, 'dir'), join(dir, 'node_modules'));
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.skipped).toEqual([{ file: 'node_modules', reason: 'symlink-outside-root' }]);
    });

    it('does not confuse a sibling directory whose name starts with the name of the root', () => {
      const dir = repo('prefix', { 'own.ts': after });
      const sibling = repo('prefix-secrets', { 'file.ts': secret });
      symlinkSync(join(sibling, 'file.ts'), join(dir, 'sibling.ts'));
      const report = check(dir);
      expect(everywhere(report)).not.toContain(MARKER);
      expect(report.skipped).toEqual([{ file: 'sibling.ts', reason: 'symlink-outside-root' }]);
    });

    it('names the link in the report, never the place it points to', () => {
      const dir = repo('link-target-name', { 'own.ts': after });
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'external.ts'));
      const listed = everywhere(check(dir).skipped);
      expect(listed).not.toContain('secret.ts');
      expect(listed).not.toContain(outside);
    });

    it('reports a dangling link instead of dropping it in silence', () => {
      const dir = repo('link-dangling', { 'own.ts': after });
      symlinkSync(join(dir, 'gone.ts'), join(dir, 'dangling.ts'));
      expect(check(dir).skipped).toEqual([{ file: 'dangling.ts', reason: 'broken-symlink' }]);
    });
  });

  describe('what it could not cover', () => {
    const lock = (padding: number) =>
      JSON.stringify({ packages: { 'node_modules/@solana/web3.js': { version: '1.98.4' } } }) +
      ' '.repeat(padding);

    it('reads a lockfile larger than the limit for source files: three of 95 in the field corpus were', () => {
      const small = check(repo('lock-small', { 'package-lock.json': lock(0) }));
      const large = check(repo('lock-large', { 'package-lock.json': lock(2 * 1024 * 1024) }));
      expect(small.findings.map((finding) => finding.excerpt)).toEqual(['@solana/web3.js@1.98.4']);
      expect(large.findings).toEqual(small.findings);
      expect(large.skipped).toEqual([]);
    });

    it('says so when a file is too large to read, a source file and a lockfile alike', () => {
      const dir = repo('too-large', {
        'bundle.js': `${before}// ${'x'.repeat(1024 * 1024)}\n`,
        'small.ts': after,
      });
      const report = check(dir);
      expect(report.findings).toEqual([]);
      expect(report.skipped).toEqual([{ file: 'bundle.js', reason: 'too-large' }]);
    });

    it('does not report a large file that no rule would read anyway', () => {
      const report = check(
        repo('large-irrelevant', { 'data.bin': 'x'.repeat(2 * 1024 * 1024), 'own.ts': after }),
      );
      expect(report.skipped).toEqual([]);
    });

    it('says so when a lockfile cannot be parsed, instead of reporting nothing about its packages', () => {
      const report = check(repo('lock-broken', { 'package-lock.json': '{ not json' }));
      expect(report.findings).toEqual([]);
      expect(report.skipped).toEqual([{ file: 'package-lock.json', reason: 'unparsable-lockfile' }]);
    });
  });

  describe('lockfiles, second round', () => {
    const yarn = (version: string) =>
      `# yarn lockfile v1\n\n"@solana/web3.js@^1.98.0":\n  version "${version}"\n  resolved "https://registry.example/web3.js.tgz"\n`;
    const excerpts = (dir: string) => check(dir).findings.map((finding) => finding.excerpt);

    it('reports a lockfile above its own limit; the limit is a parameter so that the test need not write 64 MiB', () => {
      const entries = validatePath(registry).files.flatMap((file) =>
        file.entry === undefined ? [] : [file.entry],
      );
      const dir = repo('lock-over-limit', { 'yarn.lock': yarn('1.98.4') });
      expect(checkDirectory(dir, entries).findings.map((finding) => finding.excerpt)).toEqual([
        '@solana/web3.js@1.98.4',
      ]);
      const limited = checkDirectory(dir, entries, { maxLockfileBytes: 10 });
      expect(limited.findings).toEqual([]);
      expect(limited.skipped).toEqual([{ file: 'yarn.lock', reason: 'too-large' }]);
      expect(limited.filesScanned).toBe(0);
    });

    it('reads the dependency tree of the first package-lock format', () => {
      const tree = {
        lockfileVersion: 1,
        dependencies: {
          app: { version: '1.0.0', dependencies: { '@solana/web3.js': { version: '1.98.4' } } },
        },
      };
      expect(excerpts(repo('lock-v1', { 'package-lock.json': JSON.stringify(tree) }))).toEqual([
        '@solana/web3.js@1.98.4',
      ]);
    });

    it('reads a yarn.lock with Windows line endings', () => {
      expect(excerpts(repo('lock-crlf', { 'yarn.lock': yarn('1.98.4').replaceAll('\n', '\r\n') }))).toEqual([
        '@solana/web3.js@1.98.4',
      ]);
    });

    it('says so when a yarn or pnpm lockfile does not look like one', () => {
      for (const name of ['yarn.lock', 'pnpm-lock.yaml']) {
        const report = check(repo(`lock-garbage-${name}`, { [name]: 'this is not a lockfile\n' }));
        expect(report.skipped, name).toEqual([{ file: name, reason: 'unparsable-lockfile' }]);
        expect(report.filesScanned, name).toBe(0);
      }
    });

    it('reads Cargo.lock for cargo rules only, and says so when it does not look like one', () => {
      const entries = validatePath(registry).files.flatMap((file) =>
        file.entry === undefined ? [] : [file.entry],
      );
      const entry = entries.find((item) => item.id === 'tx-v1');
      const rule = entry?.detect.find((item) => item.kind === 'lockfile-version');
      if (entry === undefined || rule?.kind !== 'lockfile-version')
        throw new Error('no lockfile rule to borrow');
      const cargo = {
        ...entry,
        detect: [
          {
            ...rule,
            rule: 'old-crate',
            package: { ecosystem: 'cargo' as const, name: 'solana-sdk', range: '<2.0.0' },
          },
        ],
      };
      const good = repo('cargo-good', {
        'Cargo.lock':
          '[[package]]\nname = "solana-sdk"\nversion = "1.18.0"\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n',
      });
      expect(checkDirectory(good, [cargo]).findings.map((finding) => finding.excerpt)).toEqual([
        'solana-sdk@1.18.0',
      ]);
      const garbage = repo('cargo-garbage', { 'Cargo.lock': 'this is not a lockfile\n' });
      expect(checkDirectory(garbage, [cargo]).skipped).toEqual([
        { file: 'Cargo.lock', reason: 'unparsable-lockfile' },
      ]);
      // With no cargo rule in the registry nothing would have read the file: not worth a word.
      expect(check(garbage).skipped).toEqual([]);
    });

    it('reads a lockfile that is a link to a file of another name inside the repository', () => {
      const dir = repo('lock-alias', {
        'locks/npm.json': JSON.stringify({
          packages: { 'node_modules/@solana/web3.js': { version: '1.98.4' } },
        }),
      });
      symlinkSync(join(dir, 'locks', 'npm.json'), join(dir, 'package-lock.json'));
      expect(excerpts(dir)).toEqual(['@solana/web3.js@1.98.4']);
    });

    it('reads hostile lockfiles in time that grows with their size, and still finds the version at their end', () => {
      const pinned = '"@solana/web3.js@^1.98.0":\n  version "1.98.4"\n';
      const hostile: Record<string, string> = {
        // what made the old expression backtrack: blocks of indented lines without a version
        blocks: `# yarn lockfile v1\n${`"@solana/web3.js@^1":\n${'  resolved "x"\n'.repeat(40)}\n`.repeat(2000)}${pinned}`,
        // what made the first rewrite quadratic: very many empty lines, and lines of spaces
        empty: `# yarn lockfile v1\n${'\n'.repeat(400_000)}${pinned}`,
        spaces: `# yarn lockfile v1\n${`${' '.repeat(50)}\n`.repeat(100_000)}${pinned}`,
      };
      for (const [name, text] of Object.entries(hostile)) {
        const started = Date.now();
        const report = check(repo(`lock-hostile-${name}`, { 'yarn.lock': text }));
        expect(Date.now() - started, name).toBeLessThan(5000);
        expect(
          report.findings.map((finding) => finding.excerpt),
          name,
        ).toEqual(['@solana/web3.js@1.98.4']);
      }
    });

    it('survives a package-lock.json with null where a package should be, and keeps the rest of the check', () => {
      for (const lock of [
        {
          packages: {
            'node_modules/@solana/web3.js': null,
            'node_modules/x/node_modules/@solana/web3.js': { version: '1.98.4' },
          },
        },
        {
          dependencies: {
            a: null,
            b: { version: '1.0.0', dependencies: { '@solana/web3.js': { version: '1.98.4' } } },
          },
        },
      ]) {
        const report = check(
          repo(`lock-null-${Object.keys(lock)[0]}`, {
            'package-lock.json': JSON.stringify(lock),
            'a.ts': before,
          }),
        );
        expect(report.findings.map((finding) => finding.excerpt)).toContain('@solana/web3.js@1.98.4');
        expect(report.findings.map((finding) => finding.file)).toContain('a.ts');
      }
    });

    it('reads the older pnpm format, tab indentation, bare carriage returns, and npm-shrinkwrap.json', () => {
      expect(
        excerpts(
          repo('pnpm-v5', {
            'pnpm-lock.yaml':
              'lockfileVersion: 5.4\n\npackages:\n\n  /@solana/web3.js/1.70.0:\n    resolution: {}\n  /@solana/web3.js/1.99.0_abc:\n    resolution: {}\n',
          }),
        ),
      ).toEqual(['@solana/web3.js@1.70.0']);
      expect(excerpts(repo('yarn-tabs', { 'yarn.lock': yarn('1.98.4').replaceAll('  ', '\t') }))).toEqual([
        '@solana/web3.js@1.98.4',
      ]);
      expect(excerpts(repo('yarn-cr', { 'yarn.lock': yarn('1.98.4').replaceAll('\n', '\r') }))).toEqual([
        '@solana/web3.js@1.98.4',
      ]);
      const shrinkwrap = JSON.stringify({
        packages: { 'node_modules/@solana/web3.js': { version: '1.98.4' } },
      });
      expect(excerpts(repo('shrinkwrap', { 'npm-shrinkwrap.json': shrinkwrap }))).toEqual([
        '@solana/web3.js@1.98.4',
      ]);
    });

    it('does not take a package whose name merely starts with the name of the rule', () => {
      const text = `# yarn lockfile v1\n\n"@solana/web3.js-extra@^1":\n  version "1.0.0"\n`;
      expect(excerpts(repo('yarn-prefix', { 'yarn.lock': text }))).toEqual([]);
      const pnpm =
        "lockfileVersion: '9.0'\n\npackages:\n\n  '@solana/web3.js-extra@1.0.0':\n    resolution: {}\n";
      expect(excerpts(repo('pnpm-prefix', { 'pnpm-lock.yaml': pnpm }))).toEqual([]);
    });

    it('accepts a yarn.lock that pins nothing yet', () => {
      const report = check(
        repo('yarn-empty', {
          'yarn.lock':
            '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n',
        }),
      );
      expect(report.skipped).toEqual([]);
      expect(report.filesScanned).toBe(1);
    });

    it('treats a link named like a lockfile that points at source code as source code', () => {
      const dir = repo('lock-named-source', { 'src.ts': before });
      symlinkSync(join(dir, 'src.ts'), join(dir, 'package-lock.json'));
      const report = check(dir);
      expect(report.findings.map((finding) => finding.file)).toEqual(['src.ts']);
      expect(report.skipped).toEqual([]);
    });

    it('reports a file it may not read instead of failing the whole check', () => {
      const dir = repo('unreadable', { 'secret.ts': before, 'own.ts': before });
      chmodSync(join(dir, 'secret.ts'), 0o000);
      try {
        const report = check(dir);
        expect(report.findings.map((finding) => finding.file)).toEqual(['own.ts']);
        expect(report.skipped).toEqual([{ file: 'secret.ts', reason: 'unreadable' }]);
      } finally {
        chmodSync(join(dir, 'secret.ts'), 0o644);
      }
    });
  });

  describe('a match that runs over several lines', () => {
    const find = (name: string, text: string) =>
      check(repo(name, { 'reader.ts': text })).findings.map(
        (finding) => `${finding.rule}@${finding.line}: ${finding.excerpt}`,
      );

    it('is found where a formatter broke the line after the colon, at the line where the match starts', () => {
      expect(
        find(
          'multi-colon',
          'const a = 1;\nrpc.getTransaction(sig, { maxSupportedTransactionVersion:\n  0 });\n',
        ),
      ).toEqual([
        'rpc-max-version-zero@2: rpc.getTransaction(sig, { maxSupportedTransactionVersion: ⏎ 0 });',
      ]);
    });

    it('is found with Windows line endings and in a file without a final newline', () => {
      expect(find('multi-crlf', 'x;\r\nmaxSupportedTransactionVersion:\r\n  0')).toEqual([
        'rpc-max-version-zero@2: maxSupportedTransactionVersion: ⏎ 0',
      ]);
    });

    it('still reports every line of a file on its own, and the same line once per rule', () => {
      const text =
        'a({ maxSupportedTransactionVersion: 0 });\nb({ maxSupportedTransactionVersion: 0, x: { maxSupportedTransactionVersion: 0 } });\n';
      expect(find('multi-lines', text).map((line) => line.split(':')[0])).toEqual([
        'rpc-max-version-zero@1',
        'rpc-max-version-zero@2',
      ]);
    });

    it('lists the findings of a file in the order of its lines, whatever the order of the rules', () => {
      const text =
        'a({ maxSupportedTransactionVersion: version });\nb({ maxSupportedTransactionVersion: 0 });\n';
      expect(find('order', text).map((line) => line.split(':')[0])).toEqual([
        'rpc-max-version-dynamic@1',
        'rpc-max-version-zero@2',
      ]);
    });

    it('shows every line of a match in the excerpt, so that the offending value is visible', () => {
      expect(
        find(
          'excerpt',
          'f({ maxSupportedTransactionVersion: 1 }); g({ maxSupportedTransactionVersion:\n  0 });\n',
        ),
      ).toEqual([
        'rpc-max-version-zero@1: f({ maxSupportedTransactionVersion: 1 }); g({ maxSupportedTransactionVersion: ⏎ 0 });',
      ]);
    });

    const withPattern = (pattern: string) => {
      const entries = validatePath(registry).files.flatMap((file) =>
        file.entry === undefined ? [] : [file.entry],
      );
      const entry = entries.find((item) => item.id === 'tx-v1');
      const rule = entry?.detect.find((item) => item.kind === 'code-pattern');
      if (entry === undefined || rule?.kind !== 'code-pattern') throw new Error('no pattern rule to borrow');
      return [{ ...entry, detect: [{ ...rule, rule: 'borrowed', pattern }] }];
    };

    it('keeps ^ and $ meaning a line: a pattern is written for lines', () => {
      const dir = repo('anchors', { 'a.ts': 'first;\nlegacy = 0\nnot legacy = 0\nlegacy = 0;\n' });
      expect(
        checkDirectory(dir, withPattern('^legacy = 0$')).findings.map((finding) => finding.line),
      ).toEqual([2]);
    });

    it('never shows a pattern a carriage return: a pattern that spells out \\n matches Windows files too', () => {
      const dir = repo('crlf-explicit', { 'a.ts': 'first;\r\nlegacy =\r\n0;\r\n' });
      const found = checkDirectory(dir, withPattern('legacy =\\n0;')).findings;
      expect(found.map((finding) => [finding.line, finding.excerpt])).toEqual([[2, 'legacy = \u23ce 0;']]);
    });

    it('shows the first and the last line of a long match, and cuts long lines, so that both ends stay in sight', () => {
      const long = `get({ maxSupportedTransactionVersion:${'\n'.repeat(7)}  0 });\n`;
      expect(find('excerpt-long', long)).toEqual([
        'rpc-max-version-zero@1: get({ maxSupportedTransactionVersion: \u23ce \u2026 \u23ce 0 });',
      ]);
      const wide = `${'x'.repeat(300)} get({ maxSupportedTransactionVersion:\n  0 });\n`;
      const [excerpt] = find('excerpt-wide', wide);
      expect(excerpt?.endsWith('\u23ce 0 });')).toBe(true);
      expect(excerpt?.length).toBeLessThan(260);
    });

    it('does not join what the language keeps apart: the fixed value stays clean over several lines too', () => {
      expect(find('multi-fixed', 'get(sig, { maxSupportedTransactionVersion:\n  1 });\n')).toEqual([]);
      expect(find('multi-hex', 'get(sig, { maxSupportedTransactionVersion:\n  0x1 });\n')).toEqual([]);
    });
  });

  describe('commented-out code', () => {
    const lines = (name: string, files: Record<string, string>) =>
      check(repo(name, files)).findings.map((finding) => `${finding.file}:${finding.line}`);

    it('is not reported when the whole line is a comment, in the comment syntax of the language', () => {
      expect(
        lines('comments', {
          'a.ts': `// old: { maxSupportedTransactionVersion: 0 }\n/* { maxSupportedTransactionVersion: 0 } */\n/**\n * pass { maxSupportedTransactionVersion: 0 }\n */\n`,
          'b.rs': '// max_supported_transaction_version: Some(0),\n',
          'c.go': '// MaxSupportedTransactionVersion: &rpc.MaxSupportedTransactionVersion0,\n',
          'd.py': '# client.get_transaction(sig, max_supported_transaction_version=0)\n',
        }),
      ).toEqual([]);
    });

    it('is still reported after code on the same line, in a string, and where a star starts real code', () => {
      expect(
        lines('not-comments', {
          'a.ts': `get(sig, { maxSupportedTransactionVersion: 0 }); // why\nconst s = '{ maxSupportedTransactionVersion: 0 }';\n`,
          'c.go':
            '*opts = rpc.GetTransactionOpts{MaxSupportedTransactionVersion: &rpc.MaxSupportedTransactionVersion0}\n',
        }),
      ).toEqual(['a.ts:1', 'a.ts:2', 'c.go:1']);
    });

    it('does not apply to documentation: a rule for markdown means what it says', () => {
      expect(lines('docs-hash', { 'README.md': '# maxSupportedTransactionVersion: 0\n' })).toEqual([
        'README.md:1',
      ]);
    });
  });

  it('says which rules it could not run', () => {
    expect(check(repo('empty', { 'a.ts': 'export {};\n' })).notRun).toMatchObject([
      { entry: 'tx-v1', rule: 'rpc-reads-v1-transaction' },
    ]);
  });
});
