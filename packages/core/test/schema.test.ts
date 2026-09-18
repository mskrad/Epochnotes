import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ENTRY_SCHEMA_VERSION, entryJsonSchema } from '../src/index.js';
import { brokenFixtures, committedSchema, reference } from './helpers.js';

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
    // `uri` is an annotation here: no format plugin is loaded, so formats are not asserted by ajv.
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(committedSchema);

    it('accepts the reference entry', () => {
      expect(validate(reference())).toBe(true);
    });

    it.each(brokenFixtures)('rejects $name', ({ yaml }) => {
      expect(validate(parse(yaml))).toBe(false);
    });
  });
});
