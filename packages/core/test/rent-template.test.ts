import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { withdrawExcessTemplate } from '../src/index.js';

const tested = readFileSync(
  new URL('../../../programs/rent-example/src/withdraw_excess.rs', import.meta.url),
  'utf8',
);

describe('withdraw_excess template', () => {
  it('is, with the default options, the very file that the on-chain test exercises', () => {
    expect(withdrawExcessTemplate()).toBe(tested);
  });

  it('fills in the account type and the authority field, and nothing else', () => {
    const custom = withdrawExcessTemplate({ accountType: 'Position', authorityField: 'owner' });
    expect(custom).toContain("pub account: Account<'info, Position>,");
    expect(custom).toContain('has_one = owner @ WithdrawExcessError::NotAuthority');
    expect(custom).toContain("pub owner: Signer<'info>,");
    expect(custom).toContain('ctx.accounts.owner.to_account_info()');
    expect(custom).not.toContain('Vault');
    const back = custom
      .replaceAll('Position', 'Vault')
      .replace('has_one = owner @', 'has_one = authority @')
      .replace("pub owner: Signer<'info>", "pub authority: Signer<'info>")
      .replace('ctx.accounts.owner.', 'ctx.accounts.authority.');
    expect(back).toBe(tested);
  });

  it('warns, in the text a developer copies, that it takes everything above the minimum', () => {
    expect(tested).toContain('WARNING: it takes EVERYTHING the account holds above the rent-exempt minimum');
    expect(tested).not.toContain('and nothing more');
  });

  it('asks the cluster for the minimum at run time and carries no rate', () => {
    expect(tested).toContain('Rent::get()?.minimum_balance(account.data_len())');
    expect(tested).not.toMatch(/\d{3,}/);
  });

  it('refuses options that are not Rust identifiers: the text goes into a source file', () => {
    expect(() => withdrawExcessTemplate({ accountType: 'Vault>; evil' })).toThrow('is not a Rust type name');
    expect(() => withdrawExcessTemplate({ authorityField: 'Owner' })).toThrow('is not a Rust field name');
    for (const options of [
      { authorityField: 'account' },
      { authorityField: 'type' },
      { accountType: 'Self' },
    ])
      expect(() => withdrawExcessTemplate(options)).toThrow('Rust keyword or is used by the template itself');
  });
});
