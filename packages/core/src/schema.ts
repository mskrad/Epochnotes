import { z } from 'zod';

import { SOLANA_CHAINS } from './chains.js';

/** The registry entry format this library writes. */
export const ENTRY_SCHEMA_VERSION = 2;
/** The formats it reads: a version signed in an older format keeps verifying. */
export const READABLE_SCHEMA_VERSIONS = [1, 2] as const;

const slug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const text = z.string().min(1);

const gate = z.strictObject({
  address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  label: text,
  effect: z.string().optional(),
});

const versionRange = z.strictObject({
  ecosystem: z.enum(['npm', 'cargo', 'client']),
  name: text,
  range: text,
});

/**
 * The clusters a probe fixture may name. An endpoint is recognised by its genesis hash, and one it does not
 * recognise is called `unknown`: a fixture free to name any cluster could therefore say `unknown` and be run
 * against every unrecognised endpoint, which would answer for a cluster nobody identified. Kept in step with
 * the genesis hashes by a test.
 */
export const PROBE_CLUSTERS = ['mainnet-beta', 'testnet', 'devnet'] as const;

const ruleBase = {
  rule: slug,
  confidence: z.enum(['breaks', 'check', 'likely-ok']),
  summary: text,
};

/** Probe fixtures of schema 2 name the chain by CAIP-2, and only a chain an endpoint can be identified as. */
const PROBE_CHAINS = Object.values(SOLANA_CHAINS);

type Language = 'ts' | 'js' | 'rust' | 'python' | 'go' | 'markdown' | 'solidity';

function detectRuleSchema<L extends readonly [Language, ...Language[]]>(
  languages: L,
  fixture: z.ZodOptional<z.ZodString>,
) {
  return z.discriminatedUnion('kind', [
    z.strictObject({
      ...ruleBase,
      kind: z.literal('code-pattern'),
      languages: z.array(z.enum(languages)).min(1),
      pattern: text.describe(
        'A JavaScript regular expression, run over the whole text of a file with the flags g and m, after Windows line endings are turned into \\n. ^ and $ mean a line; . does not cross a line; \\s and negated classes do, so that a line break inside a match does not hide it. One finding is reported per rule and starting line. Keep quantifiers bounded by the line where you can: an unbounded negated class is matched against up to one MiB of text.',
      ),
    }),
    z.strictObject({
      ...ruleBase,
      kind: z.literal('lockfile-version'),
      package: z.strictObject({ ecosystem: z.enum(['npm', 'cargo']), name: text, range: text }),
    }),
    z.strictObject({
      ...ruleBase,
      kind: z.literal('runtime-probe'),
      probe: z.strictObject({ method: text, fixture, expect: text }),
    }),
  ]);
}

const detectRuleV1 = detectRuleSchema(
  ['ts', 'js', 'rust', 'python', 'go', 'markdown'] as const,
  z
    .string()
    .regex(
      new RegExp(`^(${PROBE_CLUSTERS.join('|')}):[1-9A-HJ-NP-Za-km-z]{64,128}$`),
      `A fixture names the cluster it lives on and the signature of a transaction there, as <cluster>:<signature>. The cluster is one of ${PROBE_CLUSTERS.join(', ')}: a name no endpoint can be recognised by would be run against every endpoint whose genesis hash is not known.`,
    )
    .optional()
    .describe(
      'The transaction a probe reads, as <cluster>:<signature>. The probe runs only against an endpoint that serves that cluster.',
    ),
);

const detectRuleV2 = detectRuleSchema(
  ['ts', 'js', 'rust', 'python', 'go', 'markdown', 'solidity'] as const,
  z
    .string()
    .regex(
      new RegExp(`^(${PROBE_CHAINS.join('|')}):[1-9A-HJ-NP-Za-km-z]{64,128}$`),
      `A fixture names the chain it lives on, by its CAIP-2 id, and the signature of a transaction there, as <chain>:<signature>. The chain is one of ${PROBE_CHAINS.join(', ')}: a chain no endpoint can be identified as would be run against every endpoint that could not be placed.`,
    )
    .optional()
    .describe(
      'The transaction a probe reads, as <CAIP-2 chain>:<signature>. The probe runs only against an endpoint that serves that chain.',
    ),
);

const relations = z
  .array(z.strictObject({ type: z.enum(['requires', 'supersedes', 'related']), id: slug }))
  .default([]);

const breaks = z
  .array(
    z.strictObject({
      surface: z
        .enum(['rpc', 'decoder', 'stream', 'program', 'sdk', 'wallet', 'economics'])
        .describe(
          'Where it breaks. `program` is code that runs on chain: a Solana program, an EVM contract.',
        ),
      summary: text,
      evidence: z.array(z.int().min(0)).optional(),
    }),
  )
  .min(1);

const fix = z
  .array(
    z.strictObject({
      summary: text,
      detail: z.string().optional(),
      for_rules: z.array(slug).optional(),
      links: z.array(z.url()).optional(),
    }),
  )
  .min(1);

function sourcesSchema<K extends readonly [string, ...string[]]>(kinds: K) {
  return z
    .array(
      z.strictObject({
        kind: z.enum(kinds),
        ref: text,
        retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().optional(),
      }),
    )
    .min(1);
}

const appliesV1 = z
  .strictObject({
    gates: z.array(gate).min(1).optional(),
    versions: z.array(versionRange).min(1).optional(),
  })
  .refine((value) => value.gates !== undefined || value.versions !== undefined, {
    message: 'applies must list at least one feature gate or one version range',
  });

/**
 * Schema 1: Solana only. Read forever, because versions signed with it must keep verifying; written no more.
 * Objects are strict on purpose — an entry carries only stable facts, so fields such as an activation status
 * are rejected rather than ignored.
 */
export const entrySchemaV1 = z.strictObject({
  schema_version: z.literal(1),
  id: slug,
  rev: z.int().min(1),
  axis: z.enum(['protocol', 'client', 'library']),
  subject: z.strictObject({
    type: z.enum(['simd', 'client-release', 'package']),
    name: text,
    title: text,
  }),
  applies: appliesV1,
  relations,
  breaks,
  detect: z.array(detectRuleV1).default([]),
  fix,
  sources: sourcesSchema(['simd', 'source-code', 'release', 'rpc-observation', 'issue', 'docs'] as const),
});

const label = text.describe('The name the client source gives the change: a feature module, a fork name.');

/**
 * Where and how a change activates. One change may activate on several chains, each at its own time, so the
 * chain is part of every activation. The state is never stored: it is read from the chain when asked.
 */
const activation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('feature-account'),
    chain: z
      .literal('solana')
      .describe(
        'The namespace, not one cluster: a feature account has the same address on every Solana cluster, and its state is read from the cluster asked about.',
      ),
    address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    label,
    effect: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('timestamp'),
    chain: z
      .string()
      // No leading zero: eip155:01 would be a second name of eip155:1.
      .regex(
        /^eip155:[1-9][0-9]{0,31}$/,
        'A fork by time names one EVM chain by its CAIP-2 id, as eip155:<chain id>.',
      ),
    at: z.int().min(0).describe('Unix time, in seconds, of the first block that carries the change.'),
    label,
    effect: z.string().optional(),
    evidence: z
      .strictObject({
        header: text.describe(
          'A block header field that exists only from this fork on, such as requestsHash.',
        ),
      })
      .optional()
      .describe(
        'How a block shows the fork, so that its activation is observed rather than taken from the time.',
      ),
  }),
  z.strictObject({
    kind: z.literal('block-height'),
    chain: z
      .string()
      // In the pattern rather than a refinement, so that the published JSON Schema refuses it too.
      .regex(
        /^(?!solana:)[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/,
        'Name the chain by its CAIP-2 id; a Solana change activates by a feature account, not by a height.',
      ),
    at: z.int().min(0).describe('The first block that carries the change.'),
    label,
    effect: z.string().optional(),
  }),
]);

export type Activation = z.infer<typeof activation>;

const appliesV2 = z
  .strictObject({
    activations: z.array(activation).min(1).optional(),
    versions: z.array(versionRange).min(1).optional(),
  })
  .refine((value) => value.activations !== undefined || value.versions !== undefined, {
    message: 'applies must list at least one activation or one version range',
  });

/** Schema 2: any chain, each named by CAIP-2. One registry entry: one change on one axis. */
export const entrySchemaV2 = z.strictObject({
  schema_version: z.literal(2),
  id: slug,
  rev: z.int().min(1),
  axis: z.enum(['protocol', 'client', 'library']),
  subject: z.strictObject({
    standard: z.enum(['simd', 'eip', 'bep', 'bip', 'aip', 'sip', 'client-release', 'package']),
    name: text.describe('The id people use for it: SIMD-0385, EIP-7702, @solana/kit.'),
    title: text,
  }),
  applies: appliesV2,
  relations,
  breaks,
  detect: z.array(detectRuleV2).default([]),
  fix,
  sources: sourcesSchema([
    'simd',
    'proposal',
    'source-code',
    'release',
    'rpc-observation',
    'issue',
    'docs',
  ] as const),
});

/** The format authors write. */
export const entrySchema = entrySchemaV2;

export type EntryV1 = z.infer<typeof entrySchemaV1>;
export type EntryV2 = z.infer<typeof entrySchemaV2>;
/** An entry as it was written and signed, in either format. Hash it as it is; read it through the views below. */
export type Entry = EntryV1 | EntryV2;

/**
 * The activations of an entry in the schema-2 shape. A schema-1 gate is a feature account in the Solana
 * namespace: that is what it always meant. Only a view — the entry itself, and so its leaf, is not changed.
 */
export function activationsOf(entry: Entry): Activation[] {
  if (entry.schema_version === 2) return entry.applies.activations ?? [];
  return (entry.applies.gates ?? []).map((gate) => ({
    kind: 'feature-account' as const,
    chain: 'solana' as const,
    address: gate.address,
    label: gate.label,
    ...(gate.effect === undefined ? {} : { effect: gate.effect }),
  }));
}

/** The Solana feature gates of an entry: what a Solana cluster is asked about. */
export function featureGatesOf(entry: Entry): Extract<Activation, { kind: 'feature-account' }>[] {
  return activationsOf(entry).filter(
    (item): item is Extract<Activation, { kind: 'feature-account' }> => item.kind === 'feature-account',
  );
}

/** The subject of an entry in the schema-2 shape. */
export function subjectOf(entry: Entry): EntryV2['subject'] {
  if (entry.schema_version === 2) return entry.subject;
  return { standard: entry.subject.type, name: entry.subject.name, title: entry.subject.title };
}

/** JSON Schema of an entry as authors write it (defaults are optional). Published as `registry/schema.json`. */
export function entryJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/mskrad/Epochnotes/registry/schema.json',
    title: `Registry entry (schema_version ${ENTRY_SCHEMA_VERSION})`,
    description:
      'Format of one registry entry. Activation status is never stored in an entry: it is read from the chain at check time. Readers also accept schema_version 1, which versions signed before schema 2 contain.',
    ...z.toJSONSchema(entrySchemaV2, {
      target: 'draft-2020-12',
      io: 'input',
      // A refinement has no JSON Schema form; "at least one of activations/versions" is stated structurally instead.
      override: ({ zodSchema, jsonSchema }) => {
        if (zodSchema === appliesV2) jsonSchema.minProperties = 1;
      },
    }),
  };
}
