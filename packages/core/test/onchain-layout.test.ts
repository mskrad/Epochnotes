import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  discriminator,
  publishVersionInstruction,
  REGISTRY_PROGRAM_ID,
  revocationAddress,
  versionAddress,
} from '../src/index.js';

interface Idl {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: { name: string; writable?: boolean; signer?: boolean }[];
  }[];
  accounts: { name: string; discriminator: number[] }[];
}
const idl = JSON.parse(
  readFileSync(new URL('../../../programs/registry/idl/registry.json', import.meta.url), 'utf8'),
) as Idl;

describe('hand-written client and the program IDL', () => {
  it('target the same program', () => {
    expect(idl.address).toBe(REGISTRY_PROGRAM_ID);
  });

  it.each(idl.instructions)(
    'agree on the discriminator of instruction $name',
    ({ name, discriminator: expected }) => {
      expect([...discriminator('global', name)]).toEqual(expected);
    },
  );

  it.each(idl.accounts)(
    'agree on the discriminator of account $name',
    ({ name, discriminator: expected }) => {
      expect([...discriminator('account', name)]).toEqual(expected);
    },
  );

  it('agree on the accounts of publish_version: order, writability and the signer', async () => {
    const authority = '6VGzWhwbqcYjxWZePEonjkqC77PnWkZDrKyTwyZs2gDb';
    const built = await publishVersionInstruction(authority as never, {
      n: 1n,
      merkleRoot: 'ab'.repeat(32),
      prevRoot: '00'.repeat(32),
      contentHash: 'cd'.repeat(32),
      entryCount: 4,
      uri: 'x',
    });
    const spec = idl.instructions.find((item) => item.name === 'publish_version')?.accounts ?? [];
    // AccountRole: bit 0 = writable, bit 1 = signer
    expect(
      (built.accounts ?? []).map((account) => ({
        writable: (account.role & 1) === 1,
        signer: (account.role & 2) === 2,
      })),
    ).toEqual(
      spec.map((account) => ({ writable: account.writable === true, signer: account.signer === true })),
    );
    expect(built.accounts?.[1]?.address).toBe(await versionAddress(authority, 1n));
  });

  it('derives distinct, stable addresses', async () => {
    const authority = '6VGzWhwbqcYjxWZePEonjkqC77PnWkZDrKyTwyZs2gDb';
    expect(await versionAddress(authority, 1n)).not.toBe(await versionAddress(authority, 2n));
    expect(await revocationAddress(authority, 'tx-v1')).toBe(await revocationAddress(authority, 'tx-v1'));
    expect(await revocationAddress(authority, 'tx-v1')).not.toBe(await revocationAddress(authority, 'tx-v2'));
  });
});
