import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENTRY_SCHEMA_VERSION, entryJsonSchema, validateEntry } from '../src/index.js';
import { brokenEntries, committedSchema, reference } from './helpers.js';

describe('registry/schema.json', () => {
  it('is exactly what the zod schema generates — run `npm run schema:write` after changing the schema', () => {
    expect(committedSchema).toEqual(entryJsonSchema());
  });

  it('declares the schema version the library reads', () => {
    expect(committedSchema).toMatchObject({
      properties: { schema_version: { const: ENTRY_SCHEMA_VERSION } },
    });
  });

  describe('agrees with the validator when used by a standard JSON Schema tool', () => {
    const ajv = new Ajv2020();
    addFormats.default(ajv);
    const validate = ajv.compile(committedSchema);

    it('accepts the reference entry', () => {
      expect(validate(reference())).toBe(true);
    });

    it.each(brokenEntries)('$name: rejected iff a schema can state the defect', ({ yaml, schemaCatches }) => {
      expect(validate(parse(yaml))).toBe(!schemaCatches);
    });

    it('refuses an activation on a chain its kind cannot be read on, as the validator does', () => {
      const withActivation = (activation: Record<string, unknown>) => ({
        ...reference(),
        applies: { activations: [activation] },
      });
      const height = { kind: 'block-height', at: 1, label: 'x' };
      const fork = { kind: 'timestamp', at: 1, label: 'x' };
      for (const [activation, valid] of [
        [{ ...height, chain: 'bip122:000000000019d6689c085ae165831e93' }, true],
        [{ ...height, chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }, false],
        [{ ...fork, chain: 'eip155:1' }, true],
        [{ ...fork, chain: 'eip155:01' }, false],
        [{ ...fork, chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }, false],
      ] as const) {
        const raw = withActivation(activation);
        expect(validate(raw), JSON.stringify(activation)).toBe(valid);
        expect(validateEntry(raw).ok, JSON.stringify(activation)).toBe(valid);
      }
    });
  });
});
