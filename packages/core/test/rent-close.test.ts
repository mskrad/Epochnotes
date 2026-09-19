import {
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type RpcTransport,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { anchorDiscriminator, discriminator, planClose, simulateClose } from '../src/index.js';

const OPENBOOK = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
const MARGINFI = 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA';
const DRIFT = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const OWNER = '6VGzWhwbqcYjxWZePEonjkqC77PnWkZDrKyTwyZs2gDb';
const ACCOUNT = 'GgBtmuSGu5i73RsY775qJqhbXw3N9o4YNPNrB9ncSXs6';
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Account data: the discriminator of the type, then zeros, with the owner key at its offset. */
function data(type: string, ownerOffset: number): string {
  const bytes = Buffer.alloc(ownerOffset + 32);
  Buffer.from(anchorDiscriminator(type), 'hex').copy(bytes, 0);
  Buffer.from(
    getAddressEncoder().encode(OWNER as Parameters<ReturnType<typeof getAddressEncoder>['encode']>[0]),
  ).copy(bytes, ownerOffset);
  return bytes.toString('base64');
}

function cluster(account: { owner: string; data: string } | null, simulation?: unknown) {
  const asked: string[] = [];
  const transport = (async ({ payload }: { payload: unknown }) => {
    const { method } = payload as { method: string };
    asked.push(method);
    const context = { slot: 11 };
    const result =
      method === 'getAccountInfo'
        ? {
            context,
            value:
              account === null
                ? null
                : {
                    ...account,
                    data: [account.data, 'base64'],
                    lamports: 9_688_320,
                    space: 1264,
                    executable: false,
                    rentEpoch: 0,
                  },
          }
        : method === 'getLatestBlockhash'
          ? { context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } }
          : method === 'getBalance'
            ? { context, value: 1_000_000 }
            : { context, value: simulation };
    return { jsonrpc: '2.0', id: 1, result };
  }) as RpcTransport;
  return { transport, asked };
}

/** The parts of a compiled version 0 message that the tests look at. */
interface Compiled {
  header: { numSignerAccounts: number };
  staticAccounts: string[];
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
}

function decode(wire: string) {
  const transaction = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  ) as unknown as Compiled;
  return { transaction, message };
}

describe('planning the return of a rent deposit', () => {
  it('builds the OpenBook v2 close for the owner stored in the account, unsigned, paid by that owner', async () => {
    const { transport } = cluster({ owner: OPENBOOK, data: data('OpenOrdersAccount', 8) });
    const plan = await planClose('https://rpc.example', ACCOUNT, transport);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan).toMatchObject({
      type: 'OpenOrdersAccount',
      action: 'close',
      owner: OWNER,
      destination: OWNER,
      lamports: 9_688_320n,
    });
    const { transaction, message } = decode(plan.transaction);
    expect(message.staticAccounts[0]).toBe(OWNER); // the fee payer
    expect(Object.values(transaction.signatures)).toEqual([null]); // one signer wanted, nothing signed
    expect(message.header.numSignerAccounts).toBe(1);
    const [instruction] = message.instructions;
    expect(message.staticAccounts[instruction?.programAddressIndex ?? -1]).toBe(OPENBOOK);
    expect(Buffer.from(instruction?.data ?? []).toString('hex')).toBe(
      Buffer.from(discriminator('global', 'close_open_orders_account')).toString('hex'),
    );
    const accounts = (instruction?.accountIndices ?? []).map((index) => message.staticAccounts[index]);
    // owner, indexer (a derived address), the account, destination = owner, system program
    expect(accounts).toHaveLength(5);
    expect([accounts[0], accounts[2], accounts[3], accounts[4]]).toEqual([
      OWNER,
      ACCOUNT,
      OWNER,
      '11111111111111111111111111111111',
    ]);
  });

  it('builds the marginfi v2 close with the owner as authority and as the payer who receives the lamports', async () => {
    const { transport } = cluster({ owner: MARGINFI, data: data('MarginfiAccount', 40) });
    const plan = await planClose('https://rpc.example', ACCOUNT, transport);
    if (!plan.ok) throw new Error(plan.reason);
    const { message } = decode(plan.transaction);
    const [instruction] = message.instructions;
    expect((instruction?.accountIndices ?? []).map((index) => message.staticAccounts[index])).toEqual([
      ACCOUNT,
      OWNER,
      OWNER,
    ]);
    expect(Buffer.from(instruction?.data ?? []).toString('hex')).toBe('badd5d223261c2f1'); // as listed in the on-chain IDL
  });

  it('refuses a Drift account with what the simulation on mainnet showed', async () => {
    const { transport } = cluster({ owner: DRIFT, data: data('User', 8) });
    const plan = await planClose('https://rpc.example', ACCOUNT, transport);
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining('InstructionFallbackNotFound') });
  });

  it('refuses an account only an admin can close, an unknown program and a missing account, each with its reason', async () => {
    const admin = await planClose(
      'https://rpc.example',
      ACCOUNT,
      cluster({ owner: OPENBOOK, data: data('Market', 8) }).transport,
    );
    expect(admin).toMatchObject({
      ok: false,
      reason: expect.stringContaining('only a program admin can close it'),
    });
    const foreign = await planClose(
      'https://rpc.example',
      ACCOUNT,
      cluster({ owner: OWNER, data: data('User', 8) }).transport,
    );
    expect(foreign).toMatchObject({ ok: false, reason: expect.stringContaining('no adapter') });
    const missing = await planClose('https://rpc.example', ACCOUNT, cluster(null).transport);
    expect(missing).toMatchObject({ ok: false, reason: 'there is no such account on this cluster' });
  });
});

describe('simulating it', () => {
  const planned = async () => {
    const plan = await planClose(
      'https://rpc.example',
      ACCOUNT,
      cluster({ owner: MARGINFI, data: data('MarginfiAccount', 40) }).transport,
    );
    if (!plan.ok) throw new Error(plan.reason);
    return plan;
  };

  it('asks only to simulate, without signature checks, and reports what the owner would receive', async () => {
    const account = (lamports: number) => ({
      lamports,
      owner: OWNER,
      data: ['', 'base64'],
      executable: false,
      rentEpoch: 0,
      space: 0,
    });
    const { transport, asked } = cluster(null, {
      err: null,
      logs: ['Program log: ok'],
      accounts: [account(17_977_400), null],
      unitsConsumed: 1,
    });
    const result = await simulateClose('https://rpc.example/?api-key=secret', await planned(), transport);
    expect(asked).toEqual(['getBalance', 'simulateTransaction']);
    expect(result).toMatchObject({
      ok: true,
      slot: '11',
      returned: 16_977_400n,
      accountAfter: 0n,
      logs: ['Program log: ok'],
    });
    expect(result.endpoint).not.toContain('secret');
  });

  it('reports the refusal of the program and no amount', async () => {
    const { transport } = cluster(null, {
      err: { InstructionError: [0, { Custom: 6043 }] },
      logs: ['Program log: Account cannot be closed'],
      accounts: null,
      unitsConsumed: 1,
    });
    const result = await simulateClose('https://rpc.example', await planned(), transport);
    expect(result).toMatchObject({ ok: false, returned: null, accountAfter: null });
    expect(result.error).toContain('6043');
    expect(result.logs.join(' ')).toContain('cannot be closed');
  });

  it('tells a simulation the cluster did not run from a refusal by the program', async () => {
    const { transport } = cluster(null, {
      err: 'AccountNotFound',
      logs: [],
      accounts: null,
      unitsConsumed: 0,
    });
    const result = await simulateClose('https://rpc.example', await planned(), transport);
    expect(result).toMatchObject({ ok: false, returned: null });
    expect(result.error).toContain('AccountNotFound');
    expect(result.notSimulated).toContain('This says nothing about whether the close would succeed');
    const refused = cluster(null, {
      err: { InstructionError: [0, { Custom: 6043 }] },
      logs: ['Program log: no'],
      accounts: null,
    });
    expect(
      (await simulateClose('https://rpc.example', await planned(), refused.transport)).notSimulated,
    ).toBeUndefined();
  });
});
