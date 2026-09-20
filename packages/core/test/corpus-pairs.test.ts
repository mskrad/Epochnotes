import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkCorpus } from '../src/index.js';

const registry = new URL('../../../registry/entries', import.meta.url).pathname;
const corpus = new URL('../../../corpus', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'epochnotes-corpus-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A copy of the corpus with one change, and the problems the check finds in it. */
function problemsAfter(name: string, change: (dir: string) => void): string[] {
  const dir = join(work, name);
  cpSync(corpus, dir, { recursive: true });
  change(dir);
  return checkCorpus(dir, registry).problems;
}
const edit = (file: string, from: string, to: string) => {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} does not contain ${from}`);
  writeFileSync(file, text.replace(from, to));
};

describe('the corpus of before/after pairs', () => {
  it('agrees with its manifest and with the engine', () => {
    const report = checkCorpus(corpus, registry);
    expect(report.problems).toEqual([]);
    expect(report.rows.length).toBeGreaterThanOrEqual(6);
    expect(report.recall.repository.of).toBeGreaterThanOrEqual(3);
  });

  it('keeps the line break of the formatter case: a formatter run over the corpus would erase what it tests', () => {
    const text = readFileSync(join(corpus, 'pairs/tx-v1/synthetic-formatter-line-break/before.ts'), 'utf8');
    expect(text).toMatch(/maxSupportedTransactionVersion:\n\s+0,/);
  });

  it('notices a case that stopped being detected, and a fix that stopped being silent', () => {
    const pair = 'pairs/tx-v1/real-whoearns-live-getblock';
    expect(
      problemsAfter('before-fixed', (dir) => edit(join(dir, pair, 'before.ts'), 'Version: 0', 'Version: 1')),
    ).toEqual([
      expect.stringContaining('real-whoearns-live-getblock: expected rpc-max-version-zero on before'),
    ]);
    expect(
      problemsAfter('after-broken', (dir) => edit(join(dir, pair, 'after.ts'), 'Version: 1', 'Version: 0')),
    ).toEqual([expect.stringContaining('real-whoearns-live-getblock: after must be silent')]);
  });

  it('wants a detected case to carry no gap', () => {
    const problems = problemsAfter('gap-on-detected', (dir) =>
      edit(
        join(dir, 'manifest.yaml'),
        'id: synthetic-variable-value',
        'id: synthetic-variable-value\n    gap: x',
      ),
    );
    expect(problems).toEqual([expect.stringContaining('a detected case has no gap to explain')]);
  });

  it('notices a recorded miss that the engine finds after all: the manifest has to be told', () => {
    const flipped = problemsAfter('miss-flipped', (dir) => {
      const manifest = join(dir, 'manifest.yaml');
      const text = readFileSync(manifest, 'utf8');
      const at = text.indexOf('id: synthetic-formatter-line-break');
      writeFileSync(
        manifest,
        text.slice(0, at) + text.slice(at).replace('detected: true', 'detected: false\n    gap: pretend'),
      );
    });
    expect(flipped).toEqual([expect.stringContaining('recorded as a miss, but the engine now reports')]);
  });

  it('notices a rule nobody expected on the before side, on a detected case and on a recorded miss alike', () => {
    const extra = '\nconst other = { maxSupportedTransactionVersion: fromConfig };\n';
    const append = (file: string) => (dir: string) =>
      writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8') + extra);
    expect(
      problemsAfter('extra-detected', append('pairs/tx-v1/real-whoearns-live-getblock/before.ts')),
    ).toEqual([expect.stringContaining('before is also reported by rpc-max-version-dynamic')]);
    // The decoder case is a recorded miss with no rule of its own: any rule that reports it is unexpected.
    const problems = problemsAfter(
      'extra-miss',
      append('pairs/tx-v1/synthetic-decoder-version-byte/before.ts'),
    );
    expect(problems).toEqual([
      expect.stringContaining('recorded as a miss, but the engine now reports rpc-max-version-dynamic'),
    ]);
  });

  it('holds a quiet sample to its word: it must be read by a rule, and no rule may report it', () => {
    const sample = 'pairs/tx-v1/quiet-other-chain-same-method/sample.ts';
    expect(
      problemsAfter('noisy', (dir) =>
        writeFileSync(
          join(dir, sample),
          `${readFileSync(join(dir, sample), 'utf8')}await connection.getTransaction(signature);\n`,
        ),
      ),
    ).toEqual([
      expect.stringContaining(
        'quiet-other-chain-same-method: must stay silent, rpc-read-without-max-version reports line',
      ),
    ]);
    expect(
      problemsAfter('unread', (dir) => {
        renameSync(join(dir, sample), join(dir, 'pairs/tx-v1/quiet-other-chain-same-method/sample.txt'));
        edit(join(dir, 'manifest.yaml'), 'file: sample.ts', 'file: sample.txt');
      }),
    ).toEqual(['quiet-other-chain-same-method: no rule of tx-v1 reads sample.txt']);
  });

  it('holds the header of an excerpt, the manifest and the notice to one story', () => {
    const manifest = (from: string, to: string) => (dir: string) =>
      edit(join(dir, 'manifest.yaml'), from, to);
    expect(problemsAfter('pr', manifest('pull_request: 68', 'pull_request: 69'))).toEqual([
      expect.stringContaining('the before file does not name the licence and the pull request'),
      expect.stringContaining('the after file does not name the licence and the pull request'),
    ]);
    expect(
      problemsAfter(
        'same-commit',
        manifest(
          'after_commit: 52e9b3979f0512b5cbb3ef03f4386852f2cc9195',
          'after_commit: e600b4bd69565b4edec82d61ce1f82ad3cad41b1',
        ),
      ),
    ).toContainEqual('real-whoearns-live-getblock: before and after name the same commit');
    const licence = problemsAfter('licence-swapped', (dir) => {
      const file = join(dir, 'manifest.yaml');
      const text = readFileSync(file, 'utf8');
      const at = text.indexOf('id: real-whoearns-live-getblock');
      writeFileSync(file, text.slice(0, at) + text.slice(at).replace('license: MIT', 'license: Apache-2.0'));
    });
    expect(licence).toContainEqual(
      expect.stringContaining('pairs/NOTICE.md has no row with its repository and the licence Apache-2.0'),
    );
    expect(
      problemsAfter('no-licence-text', (dir) => rmSync(join(dir, 'pairs/LICENSES/MIT.txt'))),
    ).toContainEqual(expect.stringContaining('pairs/LICENSES/MIT.txt is missing'));
  });

  it('notices a stray file in a case, and a manifest that is not there', () => {
    expect(
      problemsAfter('stray', (dir) =>
        writeFileSync(join(dir, 'pairs/tx-v1/synthetic-docs-snippet/notes.txt'), 'x'),
      ),
    ).toEqual(['synthetic-docs-snippet: notes.txt is neither its before nor its after file']);
    expect(problemsAfter('no-manifest', (dir) => rmSync(join(dir, 'manifest.yaml')))).toEqual([
      'there is no manifest.yaml',
    ]);
  });

  it('notices a directory without a case, a case without a source commit in its file, and an uncopyable licence', () => {
    expect(
      problemsAfter('orphan', (dir) =>
        cpSync(join(dir, 'pairs/tx-v1/synthetic-docs-snippet'), join(dir, 'pairs/tx-v1/synthetic-extra'), {
          recursive: true,
        }),
      ),
    ).toEqual(['pairs/tx-v1/synthetic-extra: not in the manifest']);
    expect(
      problemsAfter('no-commit', (dir) =>
        edit(
          join(dir, 'pairs/tx-v1/real-altude-js-gettransaction/before.ts'),
          '0547ba0cc104',
          'deadbeef0000',
        ),
      ),
    ).toEqual([
      expect.stringContaining('the before file does not name its repository, path and commit 0547ba0cc104'),
    ]);
    expect(
      problemsAfter('licence', (dir) =>
        edit(join(dir, 'manifest.yaml'), 'license: MIT', 'license: GPL-3.0-only'),
      ),
    ).toEqual([expect.stringContaining('license')]);
  });
});
