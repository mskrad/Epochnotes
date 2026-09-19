import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkRepository } from '../src/index.js';

const registry = new URL('../../../registry/entries', import.meta.url).pathname;
const pairs = new URL('../../../corpus/pairs', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'epochnotes-pairs-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const directories = (path: string) =>
  readdirSync(path, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name);

const cases = directories(pairs).flatMap((entry) =>
  directories(join(pairs, entry)).flatMap((rule) =>
    directories(join(pairs, entry, rule)).map((name) => ({
      entry,
      rule,
      name,
      path: join(pairs, entry, rule, name),
    })),
  ),
);

/** The findings of one rule on one side of a pair, checked alone in a scratch directory. */
function findings(item: (typeof cases)[number], side: 'before' | 'after') {
  const file = readdirSync(item.path).find((name) => name.startsWith(`${side}.`));
  if (file === undefined) throw new Error(`${item.path} has no ${side} file`);
  const scratch = join(work, `${item.entry}-${item.rule}-${item.name}-${side}`);
  cpSync(join(item.path, file), join(scratch, file), { recursive: true });
  const report = checkRepository(scratch, registry);
  if (!report.ok) throw new Error(JSON.stringify(report.issues));
  return report.findings.filter((finding) => finding.entry === item.entry && finding.rule === item.rule);
}

describe('before/after pairs of the corpus', () => {
  it('has pairs to check', () => {
    expect(existsSync(pairs)).toBe(true);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('keeps the line break of the formatter case: a formatter run over the corpus would erase what it tests', () => {
    const text = readFileSync(
      join(pairs, 'tx-v1/rpc-max-version-zero/formatter-line-break/before.ts'),
      'utf8',
    );
    expect(text).toMatch(/maxSupportedTransactionVersion:\n\s+0,/);
  });

  it.each(cases)('$entry $rule: $name — found before the fix, silent after it', (item) => {
    expect(findings(item, 'before').length).toBeGreaterThan(0);
    expect(findings(item, 'after')).toEqual([]);
  });
});
