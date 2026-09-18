import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/program.js';

const root = new URL('../../../', import.meta.url).pathname;

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
  process.exitCode = undefined;
  await buildProgram().parseAsync(['node', 'epochnotes', ...args]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

afterEach(() => vi.restoreAllMocks());

describe('epochnotes registry validate', () => {
  it('exits 0 on the reference entry and prints its leaf', async () => {
    const { code, out } = await run('registry', 'validate', `${root}registry/entries/tx-v1.yaml`);
    expect(code).toBe(0);
    expect(out).toMatch(/^OK .*tx-v1@1 {2}leaf [0-9a-f]{64}$/);
  });

  it('exits 0 on the whole entries directory', async () => {
    expect((await run('registry', 'validate', `${root}registry/entries`)).code).toBe(0);
  });

  it('exits 1 on a broken entry and says how to fix it', async () => {
    const { code, out } = await run(
      'registry',
      'validate',
      `${root}packages/core/test/fixtures/bad-status-field.yaml`,
    );
    expect(code).toBe(1);
    expect(out).toContain('fix: Remove it: activation status is never stored in an entry');
  });

  it('exits 2 when the path cannot be read', async () => {
    expect((await run('registry', 'validate', `${root}no-such-file.yaml`)).code).toBe(2);
  });

  it('prints machine-readable JSON with --json', async () => {
    const { out } = await run('registry', 'validate', '--json', `${root}registry/entries/tx-v1.yaml`);
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: [{ id: 'tx-v1', rev: 1 }] });
  });
});
