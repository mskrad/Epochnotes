import { readdirSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';

const root = new URL('../../../', import.meta.url);

export const referenceYaml = readFileSync(new URL('registry/entries/tx-v1.yaml', root), 'utf8');
export const committedSchema = JSON.parse(
  readFileSync(new URL('registry/schema.json', root), 'utf8'),
) as Record<string, unknown>;

const fixturesUrl = new URL('./fixtures/', import.meta.url);
export const brokenFixtures = readdirSync(fixturesUrl)
  .filter((name) => name.startsWith('bad-'))
  .sort()
  .map((name) => ({ name, yaml: readFileSync(new URL(name, fixturesUrl), 'utf8') }));

/**
 * Untyped on purpose: tests corrupt arbitrary nested fields to prove the validator catches them,
 * which a precise type would forbid at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseEntry = Record<string, any>;

/** A fresh, mutable copy of the reference entry as plain data. */
export function reference(): LooseEntry {
  return parse(referenceYaml) as LooseEntry;
}
