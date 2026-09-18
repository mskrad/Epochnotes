import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ENTRY_SCHEMA_VERSION } from '../src/index.js';

const designSchema = JSON.parse(
  readFileSync(new URL('../../../docs/design/UR-001-entry.schema.json', import.meta.url), 'utf8'),
) as { properties: { schema_version: { const: number } } };

describe('core', () => {
  it('reads the same entry schema version that the design schema declares', () => {
    expect(ENTRY_SCHEMA_VERSION).toBe(designSchema.properties.schema_version.const);
  });
});
