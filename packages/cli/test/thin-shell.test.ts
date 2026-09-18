import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url).pathname;
const eslint = new ESLint({ cwd: root });

async function restrictedImports(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: `${root}packages/cli/src/probe.ts` });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('cli stays a thin shell', () => {
  it('rejects imports other than core, the argument parser, node builtins and own files', async () => {
    const messages = await restrictedImports("import 'fs';\nimport 'yaml';\nimport '@solana/kit';\n");
    expect(messages).toHaveLength(3);
  });

  it('accepts the allowed imports', async () => {
    const allowed =
      "import '@epochnotes/core';\nimport 'commander';\nimport 'node:fs';\nimport './program.js';\n";
    expect(await restrictedImports(allowed)).toEqual([]);
  });
});
