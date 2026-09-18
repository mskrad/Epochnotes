import { describe, expect, it } from 'vitest';

import { ENTRY_SCHEMA_VERSION } from '../src/index.js';

describe('core', () => {
  it('exposes the entry schema version', () => {
    expect(ENTRY_SCHEMA_VERSION).toBe(1);
  });
});
