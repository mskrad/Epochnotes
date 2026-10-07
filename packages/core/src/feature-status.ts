import {
  address,
  createSolanaRpc,
  type GetGenesisHashApi,
  type GetMultipleAccountsApi,
  type Rpc,
} from '@solana/kit';

/** JSON-RPC endpoints of the Solana clusters: the public ones, and a validator on this machine. */
export const CLUSTERS = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  testnet: 'https://api.testnet.solana.com',
  devnet: 'https://api.devnet.solana.com',
  /** `solana-test-validator` on this machine. */
  localnet: 'http://127.0.0.1:8899',
} as const;

/** A Solana cluster with a public endpoint known to this library. */
export type Cluster = keyof typeof CLUSTERS;

const FEATURE_PROGRAM = 'Feature111111111111111111111111111111111111';
const FEATURE_ACCOUNT_SIZE = 9;
/** A public endpoint that does not answer must not hang a command. */
const RPC_TIMEOUT_MS = 20_000;

/**
 * What the network says about one feature gate. It is never stored in a registry entry: it is read at
 * check time, so a report always names the cluster and the slot the answer belongs to.
 */
export type FeatureState =
  /** No feature account: activation is not scheduled on this cluster. */
  | { state: 'absent' }
  /** The account exists but is not activated yet: it activates on an epoch boundary. */
  | { state: 'pending' }
  | { state: 'active'; activatedAt: bigint }
  /** The account exists but is not a feature account this library understands. */
  | { state: 'unreadable'; reason: string };

/** A feature account as an RPC node returns it: its owner and its raw data. */
export interface FeatureAccount {
  owner: string;
  data: Uint8Array;
}

/** The one RPC capability this module needs; tests substitute it without a network. */
export interface FeatureAccountSource {
  getAccounts(addresses: string[]): Promise<{ slot: bigint; accounts: (FeatureAccount | null)[] }>;
}

/** The states of the gates asked about and the slot of the answer, or why the cluster did not answer. */
export type FeatureStatusReport =
  { ok: true; slot: bigint; states: Map<string, FeatureState> } | { ok: false; error: string };

/** A feature account is a bincode `Option<u64>`: a tag byte, then the activation slot, little-endian. */
export function decodeFeatureAccount(account: FeatureAccount | null): FeatureState {
  if (account === null) return { state: 'absent' };
  if (account.owner !== FEATURE_PROGRAM) {
    return { state: 'unreadable', reason: `owned by ${account.owner}, not by the feature program` };
  }
  // A feature account is always 9 bytes: the tag and the slot, whether or not the slot is set.
  if (account.data.length !== FEATURE_ACCOUNT_SIZE) {
    return {
      state: 'unreadable',
      reason: `feature account data is ${account.data.length} bytes, expected 9`,
    };
  }
  const [tag] = account.data;
  if (tag === 0) return { state: 'pending' };
  if (tag === 1) {
    const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
    return { state: 'active', activatedAt: view.getBigUint64(1, true) };
  }
  return { state: 'unreadable', reason: `unknown feature account tag ${tag}` };
}

/**
 * Reads the state of every given gate in one request. Network failures are part of the answer rather
 * than exceptions: a status command has to say "the cluster did not answer", not crash.
 */
export async function readFeatureStatus(
  source: FeatureAccountSource,
  gateAddresses: string[],
): Promise<FeatureStatusReport> {
  const unique = [...new Set(gateAddresses)];
  if (unique.length === 0) return { ok: true, slot: 0n, states: new Map() };
  try {
    const { slot, accounts } = await source.getAccounts(unique);
    if (accounts.length !== unique.length) {
      return { ok: false, error: `RPC returned ${accounts.length} accounts for ${unique.length} addresses` };
    }
    const states = new Map(
      unique.map((gate, index) => [gate, decodeFeatureAccount(accounts[index] ?? null)]),
    );
    return { ok: true, slot, states };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Feature accounts read through a `@solana/kit` RPC client, which can also say which cluster it reads. */
export function featureAccountSourceFromRpc(
  rpc: Rpc<GetMultipleAccountsApi & GetGenesisHashApi>,
): FeatureAccountSource & {
  getGenesisHash(): Promise<string>;
} {
  return {
    async getGenesisHash() {
      return rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
    },
    async getAccounts(addresses) {
      const response = await rpc
        .getMultipleAccounts(
          addresses.map((item) => address(item)),
          { encoding: 'base64' },
        )
        .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      return {
        slot: response.context.slot,
        accounts: response.value.map((account) =>
          account === null
            ? null
            : { owner: account.owner, data: new Uint8Array(Buffer.from(account.data[0], 'base64')) },
        ),
      };
    },
  };
}

/** Feature accounts over JSON-RPC at the given endpoint. */
export function rpcFeatureAccountSource(rpcUrl: string): FeatureAccountSource & {
  getGenesisHash(): Promise<string>;
} {
  return featureAccountSourceFromRpc(createSolanaRpc(rpcUrl));
}
