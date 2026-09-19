import { createHash } from 'node:crypto';

/** Who can close an account of this type, according to the `close =` constraints of the program source. */
export type ClosableBy = 'owner' | 'admin' | 'nobody';

export interface AccountType {
  name: string;
  closableBy: ClosableBy;
  /** The instruction that closes it, and who signs. Absent when nothing in the source closes the type. */
  closeInstruction?: string;
  /** Where the 32-byte key of the owning user sits in the account data; makes the type searchable by wallet. */
  ownerOffset?: number;
}

export interface KnownProgram {
  address: string;
  name: string;
  /** The IDL the type names and signers were read from: fetched from the program's IDL account on mainnet-beta. */
  idl: { name: string; version: string; retrieved: string };
  /** The source tree in which the `close =` constraints were read. It may be ahead of the deployed program. */
  source: string;
  /** Something a reader of the report must know about this program, shown with every scan of it. */
  note?: string;
  types: AccountType[];
}

/** Anchor marks an account with the first 8 bytes of sha256("account:<TypeName>"). */
export function anchorDiscriminator(typeName: string): string {
  return createHash('sha256').update(`account:${typeName}`).digest('hex').slice(0, 16);
}

/**
 * Account types of the programs the scanner can split. A type is closable when the program source gives it an
 * Anchor `close = <destination>` constraint in some instruction; who signs that instruction (the account's
 * owner or a program admin) is read from the IDL. A type is `nobody` when no instruction in the whole source
 * tree closes it — being a mutable account of an instruction named "delete" is not enough. Types the table does
 * not list are reported as unlisted rather than guessed. Closing may have preconditions (no open orders, empty
 * balances): the split says who could ever get the deposit back, not that they can today.
 */
export const KNOWN_PROGRAMS: KnownProgram[] = [
  {
    address: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
    name: 'OpenBook v2',
    idl: { name: 'openbook_v2', version: '0.1.0', retrieved: '2026-09-19' },
    source: 'github.com/openbook-dex/openbook-v2 @ f3e17421e675',
    types: [
      {
        name: 'OpenOrdersAccount',
        closableBy: 'owner',
        closeInstruction: 'closeOpenOrdersAccount (signer: owner)',
        ownerOffset: 8,
      },
      {
        name: 'OpenOrdersIndexer',
        closableBy: 'owner',
        closeInstruction: 'closeOpenOrdersIndexer (signer: owner)',
      },
      { name: 'Market', closableBy: 'admin', closeInstruction: 'closeMarket (signer: closeMarketAdmin)' },
      { name: 'BookSide', closableBy: 'admin', closeInstruction: 'closeMarket (signer: closeMarketAdmin)' },
      { name: 'EventHeap', closableBy: 'admin', closeInstruction: 'closeMarket (signer: closeMarketAdmin)' },
      { name: 'StubOracle', closableBy: 'owner', closeInstruction: 'stubOracleClose (signer: owner)' },
    ],
  },
  {
    address: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
    name: 'marginfi v2',
    idl: { name: 'marginfi', version: '0.1.8', retrieved: '2026-09-19' },
    source: 'github.com/mrgnlabs/marginfi-v2 @ 35b5c66aa689',
    types: [
      {
        name: 'MarginfiAccount',
        closableBy: 'owner',
        closeInstruction: 'marginfi_account_close (signer: authority)',
        ownerOffset: 40,
      },
      {
        name: 'Order',
        closableBy: 'owner',
        closeInstruction:
          'marginfi_account_close_order (signer: authority); a keeper can close it too, and the lamports go to fee_recipient, not necessarily to the owner',
      },
      { name: 'Bank', closableBy: 'admin', closeInstruction: 'lending_pool_close_bank (signer: admin)' },
      { name: 'MarginfiGroup', closableBy: 'nobody' },
      { name: 'BankMetadata', closableBy: 'nobody' },
      { name: 'FeeState', closableBy: 'nobody' },
      { name: 'StakedSettings', closableBy: 'nobody' },
    ],
  },
  {
    address: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
    name: 'Drift',
    idl: { name: 'drift', version: '2.150.0', retrieved: '2026-09-19' },
    source: 'github.com/drift-labs/protocol-v2 @ 13e8e9b8d614',
    // The source declares close constraints (User and SignedMsgUserOrders to their authority, markets to the
    // admin), and the on-chain IDL lists deleteUser and reclaimRent. But in this source tree the entry points of
    // the program are commented out, and the deployed program answers InstructionFallbackNotFound to
    // delete_user and reclaim_rent (simulated on mainnet-beta on the day below). What an IDL lists is not what
    // a program runs: only a simulation tells.
    note: 'As simulated on mainnet-beta on 2026-09-19, the deployed program rejects delete_user and reclaim_rent (InstructionFallbackNotFound): no account of this program can be closed today, whatever its IDL lists.',
    types: [
      { name: 'User', closableBy: 'nobody', ownerOffset: 8 },
      { name: 'UserStats', closableBy: 'nobody', ownerOffset: 8 },
      { name: 'SignedMsgUserOrders', closableBy: 'nobody' },
      { name: 'SpotMarket', closableBy: 'nobody' },
      { name: 'PerpMarket', closableBy: 'nobody' },
      { name: 'State', closableBy: 'nobody' },
    ],
  },
];

export const knownProgram = (address: string): KnownProgram | undefined =>
  KNOWN_PROGRAMS.find((program) => program.address === address);
