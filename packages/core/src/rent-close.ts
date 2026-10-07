import {
  type Address,
  address,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  type Instruction,
  type RpcTransport,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { discriminator, redactUrl } from './onchain.js';
import { anchorDiscriminator, type KnownProgram, KNOWN_PROGRAMS } from './rent-programs.js';

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

const writable = (at: Address) => ({ address: at, role: AccountRole.WRITABLE });
const readonly = (at: Address) => ({ address: at, role: AccountRole.READONLY });
const signer = (at: Address) => ({ address: at, role: AccountRole.READONLY_SIGNER });
const writableSigner = (at: Address) => ({ address: at, role: AccountRole.WRITABLE_SIGNER });
const text = (value: string) => new TextEncoder().encode(value);

/** How the rent deposit of one account type comes back to its owner. */
interface Adapter {
  program: string;
  type: string;
  /** `close` deletes the account and returns all its lamports; `reclaim` returns only what is above the minimum. */
  action: 'close' | 'reclaim';
  instructionName: string;
  /** What the program checks before it agrees, as read in its source. The simulation is what tells. */
  preconditions: string[];
  build(account: Address, owner: Address): Promise<Instruction>;
}

const OPENBOOK = address('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb');
const MARGINFI = address('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');

/**
 * Account lists and seeds are read from the program sources named in `rent-programs.ts`; the instruction
 * discriminator is Anchor's sha256("global:<snake_case name>")[..8].
 */
const ADAPTERS: Adapter[] = [
  {
    program: OPENBOOK,
    type: 'OpenOrdersAccount',
    action: 'close',
    instructionName: 'close_open_orders_account',
    preconditions: ['the account holds no open orders and no unsettled balance'],
    async build(account, owner) {
      const [indexer] = await getProgramDerivedAddress({
        programAddress: OPENBOOK,
        seeds: [text('OpenOrdersIndexer'), getAddressEncoder().encode(owner)],
      });
      return {
        programAddress: OPENBOOK,
        accounts: [
          signer(owner),
          writable(indexer),
          writable(account),
          writable(owner),
          readonly(SYSTEM_PROGRAM),
        ],
        data: discriminator('global', 'close_open_orders_account'),
      };
    },
  },
  {
    program: MARGINFI,
    type: 'MarginfiAccount',
    action: 'close',
    instructionName: 'marginfi_account_close',
    preconditions: [
      'every balance of the account is empty',
      'no active orders and no liquidation record',
      'the account is not frozen or disabled',
    ],
    build: async (account, owner) => ({
      programAddress: MARGINFI,
      // authority, then the fee payer that receives the lamports: the owner in both roles
      accounts: [writable(account), signer(owner), writableSigner(owner)],
      data: discriminator('global', 'marginfi_account_close'),
    }),
  },
];

/** The transport is replaceable so that the plan can be tested without a network. */
const rpcOf = (rpcUrl: string, transport?: RpcTransport) =>
  transport === undefined ? createSolanaRpc(rpcUrl) : createSolanaRpcFromTransport(transport);

/**
 * The unsigned transaction that returns the rent deposit of one account, and what the program checks before
 * it agrees.
 */
export interface ClosePlan {
  account: string;
  program: { address: string; name: string };
  type: string;
  action: 'close' | 'reclaim';
  instruction: string;
  /** The key stored in the account as its owner: the only one who can sign this. */
  owner: string;
  /** Where the lamports go: the owner. */
  destination: string;
  preconditions: string[];
  lamports: bigint;
  space: number;
  /** The unsigned transaction, base64 wire format, fee payer = owner. Nothing here can sign it. */
  transaction: string;
}

/** Why no close transaction is offered for an account. */
export type CloseRefusal = { ok: false; reason: string };

/** What the cluster says the close transaction would do, or why it could not say. */
export interface SimulationResult {
  endpoint: string;
  slot: string;
  ok: boolean;
  /** The program's own error when the simulation failed. */
  error?: string;
  /**
   * Set when the cluster could not run the simulation at all: the transaction was not judged. The usual cause is
   * an owner wallet that does not exist on chain or holds no lamports, so it cannot be the fee payer.
   */
  notSimulated?: string;
  logs: string[];
  /** Lamports of the destination and of the account, before and after, as the simulation reports them. */
  destination: { before: bigint; after: bigint | null };
  accountAfter: bigint | null;
  /** after - before of the destination; includes the transaction fee the owner pays. */
  returned: bigint | null;
}

function typeOf(program: KnownProgram, data: Uint8Array) {
  const head = Buffer.from(data.subarray(0, 8)).toString('hex');
  return program.types.find((type) => anchorDiscriminator(type.name) === head);
}

/**
 * Builds, and never signs, the transaction that returns the rent deposit of one account to its owner.
 * Refuses, with the reason, an account it has no adapter for — including a type nobody can close.
 */
export async function planClose(
  rpcUrl: string,
  account: string,
  transport?: RpcTransport,
): Promise<({ ok: true } & ClosePlan) | CloseRefusal> {
  const rpc = rpcOf(rpcUrl, transport);
  const at = address(account);
  const { value } = await rpc.getAccountInfo(at, { encoding: 'base64' }).send();
  if (value === null) return { ok: false, reason: 'there is no such account on this cluster' };
  const program = KNOWN_PROGRAMS.find((known) => known.address === value.owner);
  if (program === undefined)
    return {
      ok: false,
      reason: `the account belongs to ${value.owner}, a program this tool has no adapter for`,
    };
  const data = Uint8Array.from(Buffer.from(value.data[0], 'base64'));
  const type = typeOf(program, data);
  if (type === undefined)
    return { ok: false, reason: `${program.name}: the account type is not in the table` };
  const adapter = ADAPTERS.find((item) => item.program === program.address && item.type === type.name);
  if (adapter === undefined || type.ownerOffset === undefined) {
    const who =
      type.closableBy === 'nobody'
        ? (program.note ?? 'no instruction of the program closes this type')
        : type.closableBy === 'admin'
          ? `only a program admin can close it (${type.closeInstruction})`
          : `its owner can close it (${type.closeInstruction}), but there is no adapter for it yet`;
    return { ok: false, reason: `${program.name} ${type.name}: ${who}` };
  }
  const owner = getAddressDecoder().decode(data.subarray(type.ownerOffset, type.ownerOffset + 32));
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    async (m) => appendTransactionMessageInstructions([await adapter.build(at, owner)], m),
  );
  return {
    ok: true,
    account,
    program: { address: program.address, name: program.name },
    type: type.name,
    action: adapter.action,
    instruction: adapter.instructionName,
    owner,
    destination: owner,
    preconditions: adapter.preconditions,
    lamports: BigInt(value.lamports),
    space: Number(value.space),
    transaction: getBase64EncodedWireTransaction(compileTransaction(await message)),
  };
}

/**
 * Asks the cluster what the transaction would do, without signatures and without sending anything:
 * `simulateTransaction` with signature verification off and a fresh blockhash. Read-only on any cluster.
 */
export async function simulateClose(
  rpcUrl: string,
  plan: ClosePlan,
  transport?: RpcTransport,
): Promise<SimulationResult> {
  const rpc = rpcOf(rpcUrl, transport);
  const destination = address(plan.destination);
  const before = await rpc.getBalance(destination, { commitment: 'confirmed' }).send();
  const { context, value } = await rpc
    .simulateTransaction(plan.transaction as Parameters<typeof rpc.simulateTransaction>[0], {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [destination, address(plan.account)] },
    })
    .send();
  const [destinationAfter, accountAfter] = (value.accounts ?? []).map((item) =>
    item === null ? null : BigInt(item.lamports),
  );
  const ok = value.err === null;
  const after = ok ? (destinationAfter ?? null) : null;
  return {
    endpoint: redactUrl(rpcUrl),
    slot: context.slot.toString(),
    ok,
    ...(ok
      ? {}
      : {
          error: JSON.stringify(value.err, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item,
          ),
        }),
    ...(ok || value.logs?.length
      ? {}
      : {
          notSimulated:
            'The cluster did not run the transaction. The fee payer is the owner: a wallet that does not exist on chain, holds no lamports or is not a system account cannot be simulated as one. This says nothing about whether the close would succeed.',
        }),
    logs: [...(value.logs ?? [])],
    destination: { before: before.value, after },
    // A closed account is reported as null or with zero lamports, depending on the node.
    accountAfter: ok ? (accountAfter ?? 0n) : null,
    returned: after === null ? null : after - before.value,
  };
}
