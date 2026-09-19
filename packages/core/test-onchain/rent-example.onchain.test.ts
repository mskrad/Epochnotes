import {
  AccountRole,
  type Address,
  address,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
} from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { discriminator, type OnchainCluster, sendInstructions } from '../src/index.js';

const cluster: OnchainCluster = { rpcUrl: 'http://127.0.0.1:8899', wsUrl: 'ws://127.0.0.1:8900' };
// As declared in programs/rent-example/src/lib.rs and loaded at genesis by Anchor.toml.
const PROGRAM = address('HFoLn9V9XRzMUEi6SnLSunsq7XS32tfwt2k8EoN8GuXq');
const SYSTEM = address('11111111111111111111111111111111');
const VAULT_SPACE = 8n + 32n + 64n;
// What an account funded at an earlier, higher rate holds above today's minimum: here, simply sent on top.
const EXTRA = 1_234_567n;
const rpc = createSolanaRpc(cluster.rpcUrl);

const programError = (code: number) => new RegExp(`Custom program error: #${code}\\b`);
async function failure(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (error === undefined) throw new Error('expected the transaction to fail');
  const seen: string[] = [];
  for (let at: unknown = error; at instanceof Error && seen.length < 6; at = at.cause) seen.push(at.message);
  return seen.join(' | ');
}

const vaultOf = async (authority: Address) =>
  (
    await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: [new TextEncoder().encode('vault'), getAddressEncoder().encode(authority)],
    })
  )[0];

const initialize = (vault: Address, authority: Address): Instruction => ({
  programAddress: PROGRAM,
  accounts: [
    { address: vault, role: AccountRole.WRITABLE },
    { address: authority, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
  ],
  data: discriminator('global', 'initialize'),
});

const withdrawExcess = (vault: Address, authority: Address): Instruction => ({
  programAddress: PROGRAM,
  accounts: [
    { address: vault, role: AccountRole.WRITABLE },
    { address: authority, role: AccountRole.WRITABLE_SIGNER },
  ],
  data: discriminator('global', 'withdraw_excess'),
});

const transfer = (from: Address, to: Address, amount: bigint): Instruction => ({
  programAddress: SYSTEM,
  accounts: [
    { address: from, role: AccountRole.WRITABLE_SIGNER },
    { address: to, role: AccountRole.WRITABLE },
  ],
  data: Uint8Array.from([...getU32Encoder().encode(2), ...getU64Encoder().encode(amount)]),
});

const balance = async (at: Address) => (await rpc.getBalance(at, { commitment: 'confirmed' }).send()).value;

let authority: KeyPairSigner;
let stranger: KeyPairSigner;
let vault: Address;
let minimum: bigint;

beforeAll(async () => {
  const airdrop = airdropFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(cluster.wsUrl) });
  [authority, stranger] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  for (const signer of [authority, stranger])
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(1_000_000_000n),
      commitment: 'confirmed',
    });
  vault = await vaultOf(authority.address);
  minimum = await rpc.getMinimumBalanceForRentExemption(VAULT_SPACE).send();
});

describe('withdraw_excess template', () => {
  it('starts from an account that holds more than the minimum for its size', async () => {
    await sendInstructions(cluster, authority, [
      initialize(vault, authority.address),
      transfer(authority.address, vault, EXTRA),
    ]);
    expect(await balance(vault)).toBe(minimum + EXTRA);
  });

  it('refuses a signer who is not the authority of the account, and moves nothing', async () => {
    const before = await balance(vault);
    // 6000 = WithdrawExcessError::NotAuthority, raised by has_one
    expect(
      await failure(sendInstructions(cluster, stranger, [withdrawExcess(vault, stranger.address)])),
    ).toMatch(programError(6000));
    expect(await balance(vault)).toBe(before);
  });

  it('returns exactly the excess to the authority and leaves the account at the rent-exempt minimum', async () => {
    const before = await balance(authority.address);
    await sendInstructions(cluster, authority, [withdrawExcess(vault, authority.address)]);
    expect(await balance(vault)).toBe(minimum);
    // The authority paid the fee of one signature out of what came back.
    expect((await balance(authority.address)) - before).toBe(EXTRA - 5000n);
    const account = await rpc.getAccountInfo(vault, { encoding: 'base64', commitment: 'confirmed' }).send();
    expect(account.value?.owner).toBe(PROGRAM); // still there, still the program's
  });

  it('has nothing to return the second time', async () => {
    // 6001 = WithdrawExcessError::NothingToWithdraw
    expect(
      await failure(sendInstructions(cluster, authority, [withdrawExcess(vault, authority.address)])),
    ).toMatch(programError(6001));
    expect(await balance(vault)).toBe(minimum);
  });
});
