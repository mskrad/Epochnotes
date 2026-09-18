import { describe, expect, it } from 'vitest';

import { type Entry, validateEntry, validateEntryYaml, validateRegistry } from '../src/index.js';
import { brokenFixtures, reference, referenceYaml } from './helpers.js';

function issuesOf(raw: unknown) {
  const result = validateEntry(raw);
  return result.ok ? [] : result.issues;
}

function entry(overrides: Record<string, unknown>): Entry {
  const result = validateEntry({ ...reference(), ...overrides });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.entry;
}

describe('reference entry', () => {
  it('is valid', () => {
    expect(validateEntryYaml(referenceYaml)).toMatchObject({ ok: true, entry: { id: 'tx-v1', rev: 1 } });
  });
});

describe('broken entries are rejected with a place and a fix', () => {
  const expected: Record<string, { path: string; hint: RegExp }> = {
    'bad-activated-slot-in-gate.yaml': { path: 'applies.gates[0]', hint: /never stored in an entry/ },
    'bad-empty-applies.yaml': { path: 'applies', hint: /applies\.gates/ },
    'bad-empty-gates.yaml': { path: 'applies.gates', hint: /at least one item/ },
    'bad-empty-sources.yaml': { path: 'sources', hint: /at least one source/ },
    'bad-float-rev.yaml': { path: 'rev', hint: /whole number/ },
    'bad-no-sources.yaml': { path: 'sources', hint: /sources list/ },
    'bad-status-field.yaml': { path: '', hint: /never stored in an entry/ },
  };

  it('covers every fixture on disk', () => {
    expect(brokenFixtures.map((fixture) => fixture.name)).toEqual(Object.keys(expected).sort());
  });

  it.each(brokenFixtures)('$name', ({ name, yaml }) => {
    const result = validateEntryYaml(yaml);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe(expected[name]?.path);
    expect(result.issues[0]?.hint).toMatch(expected[name]?.hint ?? /^$/);
  });
});

describe('checks a schema cannot express', () => {
  it('evidence must point at an existing source', () => {
    const raw = reference();
    raw.breaks[0].evidence = [99];
    expect(issuesOf(raw)).toMatchObject([{ path: 'breaks[0].evidence[0]' }]);
  });

  it('fix.for_rules must name an existing rule', () => {
    const raw = reference();
    raw.fix[0].for_rules = ['no-such-rule'];
    expect(issuesOf(raw)).toMatchObject([{ path: 'fix[0].for_rules[0]' }]);
  });

  it('rule names are unique within an entry', () => {
    const raw = reference();
    raw.detect[1].rule = raw.detect[0].rule;
    expect(issuesOf(raw).map((issue) => issue.path)).toContain('detect[1].rule');
  });

  it('code patterns must compile', () => {
    const raw = reference();
    raw.detect[0].pattern = '(unclosed';
    expect(issuesOf(raw)).toMatchObject([{ path: 'detect[0].pattern' }]);
  });

  it('version ranges must be semver', () => {
    const raw = reference();
    raw.detect[2].package.range = 'eight-ish';
    expect(issuesOf(raw)).toMatchObject([{ path: 'detect[2].package.range' }]);
  });

  it('gate addresses must decode to 32 bytes', () => {
    const raw = reference();
    raw.applies.gates[0].address = '1'.repeat(40);
    expect(issuesOf(raw)).toMatchObject([{ path: 'applies.gates[0].address' }]);
  });

  it('reports YAML problems as issues instead of throwing', () => {
    expect(validateEntryYaml('id: a\nid: b\n')).toMatchObject({
      ok: false,
      issues: [{ hint: 'Fix the YAML syntax.' }],
    });
  });
});

describe('registry-wide checks', () => {
  it('accepts resolvable relations', () => {
    const a = entry({ id: 'a', relations: [{ type: 'requires', id: 'b' }] });
    expect(validateRegistry([a, entry({ id: 'b' })])).toEqual([]);
  });

  it('rejects duplicate ids, unresolved relations and cycles', () => {
    const a = entry({ id: 'a', relations: [{ type: 'requires', id: 'b' }] });
    const b = entry({ id: 'b', relations: [{ type: 'requires', id: 'a' }] });
    expect(validateRegistry([a, a]).map((issue) => issue.message)).toContainEqual(
      expect.stringContaining('Duplicate entry id'),
    );
    expect(validateRegistry([a]).map((issue) => issue.message)).toContainEqual(
      expect.stringContaining('No entry with id "b"'),
    );
    expect(validateRegistry([a, b]).map((issue) => issue.message)).toContainEqual(
      expect.stringContaining('Cycle in "requires"'),
    );
  });
});
