import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ENTRY_SCHEMA_VERSION } from '../src/index.js';

const registrySchema = JSON.parse(
  readFileSync(new URL('../../../registry/schema.json', import.meta.url), 'utf8'),
) as { properties: { schema_version: { const: number } } };

describe('core', () => {
  it('reads the same entry schema version that the registry schema declares', () => {
    expect(ENTRY_SCHEMA_VERSION).toBe(registrySchema.properties.schema_version.const);
  });
});
