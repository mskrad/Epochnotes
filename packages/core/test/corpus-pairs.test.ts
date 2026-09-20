import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('notices a known miss that the engine started to find: the manifest has to be told', () => {
    const problems = problemsAfter('miss-closed', (dir) =>
      edit(
        join(dir, 'manifest.yaml'),
        'id: synthetic-variable-value',
        'id: synthetic-variable-value\n    gap: x',
      ),
    );
    expect(problems).toEqual([expect.stringContaining('a detected case has no gap to explain')]);
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
