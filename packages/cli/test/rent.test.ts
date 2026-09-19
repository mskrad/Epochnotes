import { describe, expect, it } from 'vitest';

import { root, run } from './run.js';

const entries = `${root}registry/entries`;
const program = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
const nowhere = 'http://127.0.0.1:1';

describe('epochnotes rent scan', () => {
  it('wants exactly one target: a usage problem, exit 2', async () => {
    for (const args of [[], ['--program', program, '--wallet', program]]) {
      const result = await run('rent', 'scan', ...args, '--working-copy', entries, '--json');
      expect(result.code).toBe(2);
      expect((JSON.parse(result.stdout) as { error: string }).error).toContain(
        'exactly one of --program and --wallet',
      );
    }
  });

  it('refuses --sample with --wallet, an empty --offset and a mistyped address: usage problems, exit 2', async () => {
    const cases: [string[], string][] = [
      [['--wallet', program, '--sample'], '--sample works with --program only'],
      [['--program', program, '--sample', '--offset', ''], '--offset and --seed must be whole numbers'],
      [['--program', 'not-an-address'], 'not a valid base58 public key'],
    ];
    for (const [args, reason] of cases) {
      const result = await run('rent', 'scan', ...args, '--working-copy', entries);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(reason);
    }
  });

  it('refuses a sample of fewer than two groups', async () => {
    const result = await run(
      ...['rent', 'scan', '--program', program, '--sample', '--groups', '1'],
      '--working-copy',
      entries,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--groups between 2 and 256');
  });

  it('exits 2 when the endpoint does not answer, without a number in sight', async () => {
    const result = await run(
      ...['rent', 'scan', '--program', program, '--rpc-url', nowhere],
      '--working-copy',
      entries,
      '--json',
    );
    expect(result.code).toBe(2);
    const answer = JSON.parse(result.stdout) as { ok: boolean; error: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('Cannot scan');
    expect(result.stdout).not.toContain('excessNow');
  });

  it('exits 2 when the entry asked for is not in the registry', async () => {
    const result = await run(
      ...['rent', 'scan', '--program', program, '--entry', 'no-such'],
      '--working-copy',
      entries,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('the registry has no entry "no-such"');
  });

  it('exits 2 for an entry that carries no rent schedule', async () => {
    const result = await run(
      ...['rent', 'scan', '--program', program, '--entry', 'tx-v1'],
      '--working-copy',
      entries,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('is not named after a lamports_per_byte value');
  });
});
