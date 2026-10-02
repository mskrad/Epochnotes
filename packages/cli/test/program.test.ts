import { describe, expect, it } from 'vitest';

import { buildProgram, CLI_VERSION } from '../src/program.js';

describe('cli', () => {
  it('is named epochnotes and reports its version with the entry schema', () => {
    const program = buildProgram();
    expect(program.name()).toBe('epochnotes');
    expect(program.version()).toBe(`${CLI_VERSION} (entry schema 2; reads 1, 2)`);
  });
});
