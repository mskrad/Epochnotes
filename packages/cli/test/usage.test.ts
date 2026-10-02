import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { CLI_VERSION } from '../src/program.js';
import { root, run } from './run.js';

const packageVersion = (
  JSON.parse(readFileSync(`${root}packages/cli/package.json`, 'utf8')) as { version: string }
).version;

describe('exit codes', () => {
  it.each([
    ['an unknown command', ['nosuch']],
    ['an unknown option', ['status', '--nope']],
    ['a missing argument', ['registry', 'verify']],
    ['a missing required option', ['registry', 'publish']],
    ['a value outside the choices', ['registry', 'anchor', '--key', 'k', '--cluster', 'moonnet']],
  ])('%s is a usage error: 2, never the 1 that means findings', async (_what, args) => {
    const result = await run(...args);
    expect(result.code).toBe(2);
    // 2 is also what a crash gives, so the reason has to be the usage error itself
    expect(result.stderr).toMatch(/^error: /m);
    expect(result.stderr).not.toContain('failed unexpectedly');
  });

  it('--help and --version end with 0', async () => {
    expect((await run('--help')).code).toBe(0);
    expect((await run('registry', 'verify', '--help')).code).toBe(0);
    expect(await run('--version')).toMatchObject({
      code: 0,
      stdout: `${packageVersion} (entry schema 2; reads 1, 2)`,
    });
  });

  it('takes its version from package.json, not from a constant of its own', () => {
    expect(CLI_VERSION).toBe(packageVersion);
  });

  it('turns an unforeseen exception into 2, because 1 means findings', async () => {
    vi.resetModules();
    vi.doMock('../src/program.js', () => ({
      buildProgram: () => ({ parseAsync: () => Promise.reject(new TypeError('boom')) }),
    }));
    const { main } = await import('../src/main.js');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['node', 'epochnotes'])).toBe(2);
    try {
      expect(errors.mock.calls.join(' ')).toContain('failed unexpectedly: boom');
    } finally {
      vi.doUnmock('../src/program.js');
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it('offers the same clusters to every command that takes one', async () => {
    const commands = [
      ['status'],
      ['registry', 'verify'],
      ['registry', 'anchor'],
      ['registry', 'revoke'],
      ['registry', 'admit'],
      ['registry', 'suspend'],
      ['registry', 'restore'],
    ];
    const lists = await Promise.all(
      commands.map(
        async (command) =>
          /choices: (.+?), default:/.exec((await run(...command, '--help')).out.replace(/\s+/g, ' '))?.[1],
      ),
    );
    expect(new Set(lists)).toEqual(new Set(['"mainnet-beta", "testnet", "devnet", "localnet"']));
  });
});

describe('--json', () => {
  it('prints one JSON document on stdout and nothing else, for findings and for failures alike', async () => {
    const invalid = await run('registry', 'validate', '--json', `${root}packages/core/test/helpers.ts`);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false });
    expect(invalid.stderr).toBe('');

    const unreadable = await run(
      'check',
      'repo',
      `${root}no-such-dir`,
      '--registry',
      `${root}registry/entries`,
      '--json',
    );
    expect(unreadable.code).toBe(2);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Cannot check'),
    });
    expect(unreadable.stderr).toBe('');

    const unreachable = await run(
      'status',
      '--registry',
      `${root}registry/entries`,
      '--rpc-url',
      'http://127.0.0.1:9',
      '--json',
    );
    expect(unreachable.code).toBe(2);
    expect(JSON.parse(unreachable.stdout)).toMatchObject({ ok: false, kind: 'network' });
    expect(unreachable.stderr).toBe('');
  });

  it('answers in JSON for a usage error and for a refused confirmation too, always with ok: false', async () => {
    const usage = await run('registry', 'verify', '--json');
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Usage error'),
    });

    const unconfirmed = await run('registry', 'revoke', '--key', 'k.json', '--entry', 'tx-v1', '--json');
    expect(unconfirmed.code).toBe(2);
    expect(JSON.parse(unconfirmed.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining('--yes'),
    });
    expect(unconfirmed.stderr).toBe('');

    const badPin = await run('registry', 'verify', 'tx-v1', '--pin', 'latest', '--json');
    expect(badPin.code).toBe(2);
    expect(JSON.parse(badPin.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('--pin') });
  });

  it('keeps prose failures on stderr when --json is not asked for', async () => {
    const unreadable = await run(
      'check',
      'repo',
      `${root}no-such-dir`,
      '--registry',
      `${root}registry/entries`,
    );
    expect(unreadable).toMatchObject({ code: 2, stdout: '' });
    expect(unreadable.stderr).toContain('Cannot check');
  });
});
