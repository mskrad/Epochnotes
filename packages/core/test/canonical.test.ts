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

  it('gives one leaf for any key order, at every depth', () => {
    expect(toHex(entryLeafHash(reverseKeys(reference())))).toBe(toHex(entryLeafHash(reference())));
  });

  it('gives one leaf for LF and CRLF line endings in the YAML source', () => {
    expect(leafOfYaml(referenceYaml.replaceAll('\n', '\r\n'))).toBe(leafOfYaml(referenceYaml));
  });

  it('gives one leaf whether defaulted fields are omitted or written out empty', () => {
    const withoutRelations = referenceYaml.replace('relations: []\n', '');
    expect(withoutRelations).not.toBe(referenceYaml);
    expect(leafOfYaml(withoutRelations)).toBe(leafOfYaml(referenceYaml));
  });

  it('normalizes strings to NFC, so composed and decomposed text hash alike', () => {
    expect(toHex(entryLeafHash({ title: 'Café' }))).toBe(toHex(entryLeafHash({ title: 'Café' })));
  });

  it('treats array order as meaningful', () => {
    const swapped = reference();
    swapped.sources.reverse();
    expect(toHex(entryLeafHash(swapped))).not.toBe(toHex(entryLeafHash(reference())));
  });

  it('rejects floats and null, naming where they are', () => {
    expect(() => canonicalize({ a: [1, 1.5] })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: [1, 1.5] })).toThrow('a[1]');
    expect(() => canonicalize({ a: { b: null } })).toThrow('a.b');
  });

  it('matches the leaf computed independently (Python: sorted keys, compact JSON, sha256)', () => {
    expect(leafOfYaml(referenceYaml)).toBe(
      '4a63cca8bbedd9e2d25be1bcdd79f8248c145251184c6e4f54cfb4868c450abf',
    );
    expect(parse(referenceYaml).id).toBe('tx-v1');
  });
});
