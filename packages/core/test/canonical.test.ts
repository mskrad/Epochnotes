import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  canonicalize,
  CanonicalizationError,
  entryLeafHash,
  toHex,
  validateEntryYaml,
} from '../src/index.js';
import { reference, referenceYaml } from './helpers.js';

// Changed on 2026-10-02 with the move to schema 2 (activations per chain). The entry stays at rev 1: no version
// of the registry has been published yet, and the first published version must start every entry at rev 1.
// After the first publication this value changes only together with `rev`.
const PINNED_TX_V1_REV_1 = '10b9c1e2f2666b6e0bf657dc35cfa99e0dc7ea11879df825cad9a7afd3468beb';
// The same entry in schema 1, as versions signed before 2026-10-02 hold it. It must never change: those
// versions verify only while the reader hashes a schema-1 entry exactly as it did.
const PINNED_TX_V1_SCHEMA_1 = 'b599952c254ae6bfb1437ea32eb927c0b6a2c7f381b6a0a21ed44830858d7ea9';

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, member]) => [key, reverseKeys(member)]),
  );
}

function leafOfYaml(yaml: string): string {
  const result = validateEntryYaml(yaml);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return toHex(entryLeafHash(result.entry));
}

describe('canonical form', () => {
  it('sorts keys, drops whitespace and keeps array order', () => {
    expect(canonicalize({ b: [2, 1], a: { d: true, c: 'x' } })).toBe('{"a":{"c":"x","d":true},"b":[2,1]}');
  });

  it('gives one canonical text for any key order, at every depth', () => {
    // Compared below the validator, on raw data: zod rebuilds objects in schema order, which would hide a missing sort.
    expect(canonicalize(reverseKeys(reference()))).toBe(canonicalize(reference()));
  });

  it('gives one leaf when top-level keys are reordered in the YAML text itself', () => {
    const blocks = referenceYaml.split(/^(?=[a-z_]+:)/m);
    const header = blocks.shift() ?? '';
    expect(blocks.length).toBeGreaterThan(5);
    expect(leafOfYaml(header + blocks.reverse().join(''))).toBe(leafOfYaml(referenceYaml));
  });

  it('gives one leaf for LF and CRLF line endings in the YAML source', () => {
    expect(leafOfYaml(referenceYaml.replaceAll('\n', '\r\n'))).toBe(leafOfYaml(referenceYaml));
  });

  it('normalizes line endings inside literal block scalars too', () => {
    const literal = referenceYaml
      .replace('relations: []\n', '')
      .replace(/^fix:\n {2}- summary: .*$/m, 'fix:\n  - summary: |-\n      first line\n      second line');
    expect(literal).toContain('first line');
    expect(leafOfYaml(literal.replaceAll('\n', '\r\n'))).toBe(leafOfYaml(literal));
  });

  it('gives one leaf whether defaulted fields are omitted or written out empty', () => {
    const withoutRelations = referenceYaml.replace('relations: []\n', '');
    expect(withoutRelations).not.toBe(referenceYaml);
    expect(leafOfYaml(withoutRelations)).toBe(leafOfYaml(referenceYaml));
  });

  it('normalizes strings to NFC, so composed and decomposed text hash alike', () => {
    expect(canonicalize({ title: 'Café' })).toBe(canonicalize({ title: 'Café' }));
  });

  it('treats array order as meaningful', () => {
    const swapped = reference();
    swapped.sources.reverse();
    expect(canonicalize(swapped)).not.toBe(canonicalize(reference()));
  });

  it('rejects floats and null, naming where they are', () => {
    expect(() => canonicalize({ a: [1, 1.5] })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: [1, 1.5] })).toThrow('a[1]');
    expect(() => canonicalize({ a: { b: null } })).toThrow('a.b');
  });

  it('refuses keys that collide once normalized', () => {
    expect(() => canonicalize({ 'caf\u00e9': 1, 'cafe\u0301': 2 })).toThrow('collide');
  });

  it('pins the leaf of tx-v1 rev 1: changing the entry without raising rev must be a conscious act', () => {
    expect(parse(referenceYaml)).toMatchObject({ id: 'tx-v1', rev: 1 });
    expect(leafOfYaml(referenceYaml)).toBe(PINNED_TX_V1_REV_1);
  });

  it('hashes a schema-1 entry exactly as it did before schema 2', () => {
    const v1 = readFileSync(new URL('./fixtures/schema-v1/tx-v1.yaml', import.meta.url), 'utf8');
    expect(parse(v1)).toMatchObject({ schema_version: 1, id: 'tx-v1', rev: 1 });
    expect(leafOfYaml(v1)).toBe(PINNED_TX_V1_SCHEMA_1);
  });
});
