import { describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../src/program.js';
import { run } from './run.js';

describe('exit codes', () => {
  it.each([
    ['an unknown command', ['nosuch']],
    ['an unknown option', ['status', '--nope']],
    ['a missing argument', ['registry', 'verify']],
    ['a missing required option', ['registry', 'publish']],
    ['a value outside the choices', ['registry', 'anchor', '--key', 'k', '--cluster', 'moonnet']],
  ])('%s is a usage error: 2, never the 1 that means findings', async (_what, args) => {
    expect((await run(...args)).code).toBe(2);
  });

  it('--help and --version end with 0', async () => {
    expect((await run('--help')).code).toBe(0);
    expect((await run('registry', 'verify', '--help')).code).toBe(0);
    const version = await run('--version');
    expect(version.code).toBe(0);
    expect(version.out).toContain(`${CLI_VERSION} (entry schema 1)`);
  });

  it('takes its version from package.json', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('offers the same clusters to every command that takes one', async () => {
    const lists = await Promise.all(
      [
        ['status'],
        ['registry', 'verify'],
        ['registry', 'anchor'],
        ['registry', 'revoke'],
        ['registry', 'admit'],
        ['registry', 'suspend'],
      ].map(
        async (command) =>
          /choices: (.+?), default:/.exec((await run(...command, '--help')).out.replace(/\s+/g, ' '))?.[1],
      ),
    );
    expect(new Set(lists)).toEqual(new Set(['"mainnet-beta", "testnet", "devnet", "localnet"']));
  });
});
