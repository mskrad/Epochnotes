import { z } from 'zod';

/** Version of the registry entry format this library reads and writes. */
export const ENTRY_SCHEMA_VERSION = 1;

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

const ruleBase = {
  rule: slug,
  confidence: z.enum(['breaks', 'check', 'likely-ok']),
  summary: text,
};

const detectRule = z.discriminatedUnion('kind', [
  z.strictObject({
    ...ruleBase,
    kind: z.literal('code-pattern'),
    languages: z.array(z.enum(['ts', 'js', 'rust', 'python', 'go', 'markdown'])).min(1),
    pattern: text,
  }),
  z.strictObject({
    ...ruleBase,
    kind: z.literal('lockfile-version'),
    package: z.strictObject({ ecosystem: z.enum(['npm', 'cargo']), name: text, range: text }),
  }),
  z.strictObject({
    ...ruleBase,
    kind: z.literal('runtime-probe'),
    probe: z.strictObject({ method: text, fixture: z.string().optional(), expect: text }),
  }),
]);

const applies = z
  .strictObject({
    gates: z.array(gate).min(1).optional(),
    versions: z.array(versionRange).min(1).optional(),
  })
  .refine((value) => value.gates !== undefined || value.versions !== undefined, {
    message: 'applies must list at least one feature gate or one version range',
  });

/**
 * One registry entry: one change on one axis. Objects are strict on purpose — an entry carries only
 * stable facts, so fields such as an activation status are rejected rather than ignored.
 */
export const entrySchema = z.strictObject({
  schema_version: z.literal(ENTRY_SCHEMA_VERSION),
  id: slug,
  rev: z.int().min(1),
  axis: z.enum(['protocol', 'client', 'library']),
  subject: z.strictObject({
    type: z.enum(['simd', 'client-release', 'package']),
    name: text,
    title: text,
  }),
  applies,
  relations: z
    .array(z.strictObject({ type: z.enum(['requires', 'supersedes', 'related']), id: slug }))
    .default([]),
  breaks: z
    .array(
      z.strictObject({
        surface: z.enum(['rpc', 'decoder', 'stream', 'program', 'sdk', 'wallet', 'economics']),
        summary: text,
        evidence: z.array(z.int().min(0)).optional(),
      }),
    )
    .min(1),
  detect: z.array(detectRule).default([]),
  fix: z
    .array(
      z.strictObject({
        summary: text,
        detail: z.string().optional(),
        for_rules: z.array(slug).optional(),
        links: z.array(z.url()).optional(),
      }),
    )
    .min(1),
  sources: z
    .array(
      z.strictObject({
        kind: z.enum(['simd', 'source-code', 'release', 'rpc-observation', 'issue', 'docs']),
        ref: text,
        retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

export type Entry = z.infer<typeof entrySchema>;

/** JSON Schema of an entry as authors write it (defaults are optional). Published as `registry/schema.json`. */
export function entryJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/mskrad/Epochnotes/registry/schema.json',
    title: `Registry entry (schema_version ${ENTRY_SCHEMA_VERSION})`,
    description:
      'Format of one registry entry. Activation status is never stored in an entry: it is read from the feature gate account at check time.',
    ...z.toJSONSchema(entrySchema, {
      target: 'draft-2020-12',
      io: 'input',
      // A refinement has no JSON Schema form; "at least one of gates/versions" is stated structurally instead.
      override: ({ zodSchema, jsonSchema }) => {
        if (zodSchema === applies) jsonSchema.minProperties = 1;
      },
    }),
  };
}
