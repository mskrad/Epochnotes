import { createHash } from 'node:crypto';

/** Who can close an account of this type and get its lamports back, according to the program's IDL. */
export type ClosableBy = 'owner' | 'admin' | 'nobody';

export interface AccountType {
  name: string;
  closableBy: ClosableBy;
  /** The instruction of the IDL that closes it, and who signs. Absent when the IDL has none. */
  closeInstruction?: string;
  /** Where the 32-byte key of the owning user sits in the account data; makes the type searchable by wallet. */
  ownerOffset?: number;
}

export interface KnownProgram {
  address: string;
  name: string;
  /** The IDL the table was read from: fetched from the program's IDL account on mainnet-beta. */
  idl: { name: string; version: string; retrieved: string };
  types: AccountType[];
}

/** Anchor marks an account with the first 8 bytes of sha256("account:<TypeName>"). */
export function anchorDiscriminator(typeName: string): string {
  return createHash('sha256').update(`account:${typeName}`).digest('hex').slice(0, 16);
}

/**
 * Account types of the programs the scanner can split. `closableBy` is what the IDL shows and nothing more: an
 * instruction that closes the account, and whether its signer is the account's owner or a program admin. A
 * type is `nobody` when no instruction of the IDL names it as the account being closed; types the table does not
 * list are reported as unlisted rather than guessed. Closing may still have preconditions (no open orders,
 * empty balances): the split says who could ever get the deposit back, not that they can today.
 */
export const KNOWN_PROGRAMS: KnownProgram[] = [
  {
    address: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
    name: 'OpenBook v2',
    idl: { name: 'openbook_v2', version: '0.1.0', retrieved: '2026-09-19' },
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
        closeInstruction: 'marginfi_account_close_order (signer: authority)',
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
    types: [
      {
        name: 'User',
        closableBy: 'owner',
        closeInstruction: 'deleteUser (signer: authority); reclaimRent returns the excess without closing',
        ownerOffset: 8,
      },
      {
        name: 'UserStats',
        closableBy: 'owner',
        closeInstruction: 'deleteUser (signer: authority)',
        ownerOffset: 8,
      },
      {
        name: 'SignedMsgUserOrders',
        closableBy: 'owner',
        closeInstruction: 'deleteSignedMsgUserOrders (signer: authority)',
      },
      {
        name: 'SpotMarket',
        closableBy: 'admin',
        closeInstruction: 'deleteInitializedSpotMarket (signer: admin)',
      },
      {
        name: 'PerpMarket',
        closableBy: 'admin',
        closeInstruction: 'deleteInitializedPerpMarket (signer: admin)',
      },
      { name: 'State', closableBy: 'nobody' },
    ],
  },
];

export const knownProgram = (address: string): KnownProgram | undefined =>
  KNOWN_PROGRAMS.find((program) => program.address === address);
