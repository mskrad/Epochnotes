import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

const root = new URL('../../../', import.meta.url);

export const referenceYaml = readFileSync(new URL('registry/entries/tx-v1.yaml', root), 'utf8');
export const committedSchema = JSON.parse(
  readFileSync(new URL('registry/schema.json', root), 'utf8'),
) as Record<string, unknown>;

/**
 * Untyped on purpose: tests corrupt arbitrary nested fields to prove the validator catches them,
 * which a precise type would forbid at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseEntry = Record<string, any>;

/** An entry as it was written in schema 1, before 2026-10-02: what signed versions of that time hold. */
export function v1Yaml(id: string): string {
  return readFileSync(new URL(`fixtures/schema-v1/${id}.yaml`, import.meta.url), 'utf8');
}

/** A fresh, mutable copy of the reference entry as plain data. */
export function reference(): LooseEntry {
  return parse(referenceYaml) as LooseEntry;
}

/** Applies a textual edit to the reference YAML and fails loudly if the edit no longer matches anything. */
function edit(pattern: RegExp | string, replacement: string): string {
  const edited = referenceYaml.replace(pattern, replacement);
  if (edited === referenceYaml) throw new Error(`Broken-entry edit matched nothing: ${String(pattern)}`);
  return edited;
}

const topLevelBlock = (key: string) => new RegExp(`^${key}:[\\s\\S]*?(?=^\\S|(?![\\s\\S]))`, 'm');

export interface BrokenEntry {
  name: string;
  yaml: string;
  /** Where the validator must point, and what its advice must mention. */
  path: string;
  hint: RegExp;
  /** False when the defect is beyond what a JSON Schema can state (checked by the validator only). */
  schemaCatches: boolean;
}

/**
 * Broken entries are derived from the reference entry by one edit each, so they cannot drift away from it.
 * The first seven are the variants fixed in the entry format note; the rest cover traceability of sources.
 */
export const brokenEntries: BrokenEntry[] = [
  {
    name: 'no-sources',
    yaml: edit(topLevelBlock('sources'), ''),
    path: 'sources',
    hint: /sources list/,
    schemaCatches: true,
  },
  {
    name: 'empty-sources',
    yaml: edit(topLevelBlock('sources'), 'sources: []\n'),
    path: 'sources',
    hint: /at least one source/,
    schemaCatches: true,
  },
  {
    name: 'empty-applies',
    yaml: edit(topLevelBlock('applies'), 'applies: {}\n'),
    path: 'applies',
    hint: /applies\.activations/,
    schemaCatches: true,
  },
  {
    name: 'empty-gates',
    yaml: edit(topLevelBlock('applies'), 'applies:\n  activations: []\n'),
    path: 'applies.activations',
    hint: /at least one item/,
    schemaCatches: true,
  },
  {
    name: 'status-field',
    yaml: edit('axis: protocol\n', 'axis: protocol\nstatus: active\n'),
    path: '',
    hint: /never stored in an entry/,
    schemaCatches: true,
  },
  {
    name: 'activated-field',
    yaml: edit('axis: protocol\n', 'axis: protocol\nActivated: true\n'),
    path: '',
    hint: /never stored in an entry/,
    schemaCatches: true,
  },
  {
    name: 'activated-slot-in-gate',
    yaml: edit('      label: enable_tx_v1\n', '      label: enable_tx_v1\n      activated_slot: 447120000\n'),
    path: 'applies.activations[0]',
    hint: /never stored in an entry/,
    schemaCatches: true,
  },
  {
    name: 'status-in-source',
    yaml: edit("    retrieved: '2026-09-18'\n", "    retrieved: '2026-09-18'\n    live: true\n"),
    path: 'sources[0]',
    hint: /Remove the field/,
    schemaCatches: true,
  },
  {
    name: 'float-rev',
    yaml: edit('rev: 1\n', 'rev: 1.5\n'),
    path: 'rev',
    hint: /whole number/,
    schemaCatches: true,
  },
  {
    name: 'source-without-date',
    yaml: edit("    retrieved: '2026-09-18'\n", ''),
    path: 'sources[0].retrieved',
    hint: /date the source was read/,
    schemaCatches: true,
  },
  {
    name: 'source-date-wrong-shape',
    yaml: edit("retrieved: '2026-09-18'", "retrieved: '18.09.2026'"),
    path: 'sources[0].retrieved',
    hint: /date the source was read/,
    schemaCatches: true,
  },
  {
    name: 'source-date-not-in-calendar',
    yaml: edit("retrieved: '2026-09-18'", "retrieved: '2026-99-99'"),
    path: 'sources[0].retrieved',
    hint: /real date/,
    schemaCatches: false,
  },
  {
    name: 'link-not-a-url',
    yaml: edit(
      '      - https://github.com/anza-xyz/kit/releases/tag/v8.0.0\n',
      '      - see the kit release notes\n',
    ),
    path: 'fix[1].links[0]',
    hint: /schema\.json/,
    schemaCatches: true,
  },
];
