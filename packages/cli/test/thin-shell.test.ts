import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url).pathname;
const eslint = new ESLint({ cwd: root });

async function restrictedImports(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath: `${root}packages/cli/src/probe.ts` });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('cli stays a thin shell', () => {
  it('rejects every import but core, the argument parser, node:module and own files', async () => {
    const forbidden = [
      "import 'fs';",
      "import 'node:fs';",
      "import 'node:http';",
      "import 'yaml';",
      "import '@solana/kit';",
    ];
    expect(await restrictedImports(`${forbidden.join('\n')}\n`)).toHaveLength(forbidden.length);
  });

  it('accepts the allowed imports', async () => {
    const allowed =
      "import '@epochnotes/core';\nimport 'commander';\nimport 'node:module';\nimport './program.js';\n";
    expect(await restrictedImports(allowed)).toEqual([]);
  });
});
