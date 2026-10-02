import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  CLUSTER_GENESIS,
  type Entry,
  PROBE_CLUSTERS,
  SOLANA_CHAINS,
  slowPatternInput,
  validateEntry,
  validateEntryYaml,
  validateRegistry,
} from '../src/index.js';
import { brokenEntries, type LooseEntry, reference, referenceYaml, v1Yaml } from './helpers.js';

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
  it.each(brokenEntries)('$name', ({ yaml, path, hint }) => {
    const result = validateEntryYaml(yaml);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe(path);
    expect(result.issues[0]?.hint).toMatch(hint);
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

  it('a probe fixture names a chain an endpoint can be identified as', () => {
    const raw = reference();
    expect(raw.schema_version).toBe(2);
    const index = raw.detect.findIndex((rule: { kind: string }) => rule.kind === 'runtime-probe');
    const fixture = raw.detect[index].probe.fixture as string;
    const signature = fixture.slice(fixture.lastIndexOf(':') + 1);
    // `unknown` is what the probe calls an endpoint it cannot place: a fixture that named it would be run
    // against every such endpoint and answer for a chain nobody identified. A schema-1 cluster name is not a
    // CAIP-2 id, so schema 2 refuses it too.
    for (const chain of ['unknown', 'solana:unknown', 'mainnet-beta', 'devnet', 'eip155:1', 'solana', '']) {
      raw.detect[index].probe.fixture = `${chain}:${signature}`;
      const issues = issuesOf(raw);
      expect(issues, chain).toMatchObject([{ path: `detect[${index}].probe.fixture` }]);
      expect(issues[0]?.hint ?? '').toMatch(new RegExp(Object.values(SOLANA_CHAINS).join(', ')));
    }
    for (const chain of Object.values(SOLANA_CHAINS)) {
      raw.detect[index].probe.fixture = `${chain}:${signature}`;
      expect(issuesOf(raw), chain).toEqual([]);
    }
  });

  it('a schema-1 probe fixture keeps naming a cluster an endpoint can be recognised by', () => {
    const raw = parse(v1Yaml('tx-v1')) as LooseEntry;
    expect(raw.schema_version).toBe(1);
    const index = raw.detect.findIndex((rule: { kind: string }) => rule.kind === 'runtime-probe');
    const [, signature] = (raw.detect[index].probe.fixture as string).split(':');
    for (const cluster of ['unknown', 'mainnet', 'localnet', '', Object.values(SOLANA_CHAINS)[0]]) {
      raw.detect[index].probe.fixture = `${cluster}:${signature}`;
      const issues = issuesOf(raw);
      expect(issues, cluster).toMatchObject([{ path: `detect[${index}].probe.fixture` }]);
      expect(issues[0]?.hint ?? '').toMatch(/mainnet-beta, testnet, devnet/);
    }
    for (const cluster of ['mainnet-beta', 'testnet', 'devnet']) {
      raw.detect[index].probe.fixture = `${cluster}:${signature}`;
      expect(issuesOf(raw), cluster).toEqual([]);
    }
  });

  it('the CAIP-2 ids of the Solana clusters are the first 32 characters of their genesis hashes', () => {
    expect(SOLANA_CHAINS).toEqual({
      'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
      devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    });
  });

  it('the clusters a fixture may name are the clusters a genesis hash is known for', () => {
    expect([...PROBE_CLUSTERS].sort()).toEqual(Object.keys(CLUSTER_GENESIS).sort());
  });

  it('code patterns must compile', () => {
    const raw = reference();
    raw.detect[0].pattern = '(unclosed';
    expect(issuesOf(raw)).toMatchObject([{ path: 'detect[0].pattern' }]);
  });

  it('version ranges must be semver', () => {
    const raw = reference();
    const index = raw.detect.findIndex((rule: { rule: string }) => rule.rule === 'kit-below-8');
    raw.detect[index].package.range = 'eight-ish';
    expect(issuesOf(raw)).toMatchObject([{ path: `detect[${index}].package.range` }]);
  });

  it('cargo ranges may separate comparators with commas', () => {
    const raw = reference();
    raw.applies.versions = [{ ecosystem: 'cargo', name: 'solana-sdk', range: '>=4.2.0, <5.0.0' }];
    expect(issuesOf(raw)).toEqual([]);
  });

  it('gate addresses must decode to 32 bytes, in either schema', () => {
    const raw = reference();
    raw.applies.activations[0].address = '1'.repeat(40);
    expect(issuesOf(raw)).toMatchObject([{ path: 'applies.activations[0].address' }]);
    const old = parse(v1Yaml('tx-v1')) as LooseEntry;
    old.applies.gates[0].address = '1'.repeat(40);
    expect(issuesOf(old)).toMatchObject([{ path: 'applies.gates[0].address' }]);
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

describe('patterns that would be slow on a whole file', () => {
  const withPattern = (pattern: string) => {
    const raw = reference();
    raw.detect[0].pattern = pattern;
    return issuesOf(raw).filter((issue) => issue.code === 'slow-pattern');
  };

  it('refuses a pattern that rescans the rest of the file from every start, and says how to bound it', () => {
    const [issue] = withPattern('getTransaction\\([^)]*\\)');
    expect(issue).toMatchObject({ path: 'detect[0].pattern' });
    expect(issue?.message).toContain('"getTransaction(" repeated');
    expect(issue?.hint).toContain('[^;]{0,400}');
  });

  it('is not fooled by punctuation around the word, a short word, or another kind of bracket', () => {
    for (const pattern of [
      '\\.getTransaction\\((?![^;]*maxSupportedTransactionVersion)',
      'get\\([^)]*\\)',
      'getTransaction\\s*\\{[^}]*\\}',
      'maxSupportedTransactionVersion"[^}]*\\}',
      'getBlock<[^>]*>',
      '[gG]etTransaction\\([^)]*\\)',
      'getBlock\\s*=>\\s*\\{[^}]*\\}',
      'await\\s+conn\\.getTransaction\\((?![^;]*never)',
    ])
      expect(slowPatternInput(pattern), pattern).toBeDefined();
  }, 60_000);

  it('accepts the same idea once it is bounded, and every pattern of the registry', () => {
    expect(withPattern('getTransaction\\([^)]{0,400}\\)')).toEqual([]);
    for (const rule of reference().detect)
      if (rule.kind === 'code-pattern') expect(slowPatternInput(rule.pattern), rule.rule).toBeUndefined();
  });
});
