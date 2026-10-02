import { chainNameOf, namespaceOf, solanaChainId } from './chains.js';
import { evmActivationReader } from './evm-activation.js';
import {
  type FeatureAccountSource,
  type FeatureState,
  readFeatureStatus,
  rpcFeatureAccountSource,
} from './feature-status.js';
import { httpJsonRpc } from './json-rpc.js';
import { type Activation, activationsOf, type Entry, subjectOf } from './schema.js';

/**
 * Where a reading was taken: the slot of a Solana answer; the block and its time on chains that have them.
 * Numbers are decimal strings, so that no JSON reader rounds them.
 */
export interface ReadingPoint {
  slot?: string;
  block?: string;
  time?: string;
}

/**
 * What a chain says about one activation, in one shape for every chain. It is never stored in an entry: it is
 * read when asked, and a report names the chain and the point of the reading.
 */
export type ActivationState =
  /** Nothing scheduled on this chain. */
  | { state: 'absent' }
  /** Known to the chain, not reached yet. */
  | { state: 'scheduled' }
  /**
   * In force. `confirmedBy` says what showed it: the feature account itself, a block header field, the node's
   * own report, or only the time or height compared with the head.
   */
  | {
      state: 'active';
      since: ReadingPoint;
      confirmedBy: 'feature-account' | 'header' | 'node' | 'chain-data' | 'time-only' | 'height-only';
    }
  /** Nothing could be learned: no adapter, an answer this library does not understand, a conflict. */
  | { state: 'unknown'; reason: string };

/** Reads the activations of one chain behind one endpoint. Tests substitute it without a network. */
export interface ActivationReader {
  /**
   * The CAIP-2 id of the chain the endpoint serves, as the endpoint says, not as the user named it, and what
   * showed it: the genesis block, only the chain id the endpoint states, or nothing — the name the user gave.
   */
  identify(): Promise<{ chain: string; by: 'genesis' | 'chain-id' | 'asked' }>;
  /** States in the order of `activations`, and the point they were read at. */
  read(activations: Activation[]): Promise<{ point: ReadingPoint; states: ActivationState[] }>;
}

/** A Solana feature-account source that can also say which cluster it reads. */
export interface SolanaReadSource extends FeatureAccountSource {
  getGenesisHash(): Promise<string>;
}

export function activationStateOfFeature(state: FeatureState): ActivationState {
  switch (state.state) {
    case 'absent':
      return { state: 'absent' };
    case 'pending':
      return { state: 'scheduled' };
    case 'active':
      return {
        state: 'active',
        since: { slot: state.activatedAt.toString() },
        confirmedBy: 'feature-account',
      };
    case 'unreadable':
      return { state: 'unknown', reason: state.reason };
  }
}

/** Solana: the state of a feature account, read in one request. */
export function solanaActivationReader(source: SolanaReadSource): ActivationReader {
  return {
    async identify() {
      const genesis: unknown = await source.getGenesisHash();
      // What the endpoint says about itself decides which chain the report names: an answer that is not a
      // genesis hash names none.
      if (typeof genesis !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis))
        throw new Error(
          `the endpoint answered getGenesisHash with ${JSON.stringify(genesis)}, not a genesis hash`,
        );
      return { chain: solanaChainId(genesis), by: 'genesis' as const };
    },
    async read(activations) {
      const addresses = activations.map((item) =>
        item.kind === 'feature-account' ? item.address : undefined,
      );
      const report = await readFeatureStatus(
        source,
        addresses.filter((item): item is string => item !== undefined),
      );
      if (!report.ok) throw new Error(report.error);
      return {
        point: { slot: report.slot.toString() },
        states: addresses.map((address) =>
          address === undefined
            ? { state: 'unknown', reason: 'a Solana cluster is asked about feature accounts only' }
            : activationStateOfFeature(
                report.states.get(address) ?? {
                  state: 'unreadable',
                  reason: 'no state returned for this feature account',
                },
              ),
        ),
      };
    },
  };
}

/**
 * For a chain this library has no adapter for. It cannot even confirm which chain the endpoint serves, so it
 * takes the requested one at its word and says, for every activation, that nothing was read.
 */
export function unsupportedReader(chain: string): ActivationReader {
  return {
    identify: () => Promise.resolve({ chain, by: 'asked' as const }),
    read: (activations) =>
      Promise.resolve({
        point: {},
        states: activations.map(() => ({
          state: 'unknown' as const,
          reason: `this version of epochnotes has no adapter for ${chain}`,
        })),
      }),
  };
}

/**
 * The reader for a chain behind an endpoint. Chosen by the full CAIP-2 id, not by its namespace: one namespace
 * can hold chains read differently (bip122 holds Bitcoin and Zcash). Solana is the exception that proves it:
 * every Solana cluster is read the same way, and which one an endpoint serves is learned from the endpoint.
 */
export function activationReaderFor(chain: string | undefined, rpcUrl: string): ActivationReader {
  if (chain === undefined || namespaceOf(chain) === 'solana')
    return solanaActivationReader(rpcFeatureAccountSource(rpcUrl));
  // Every EVM chain is read the same way; the genesis block is checked where this library pins it.
  if (namespaceOf(chain) === 'eip155') return evmActivationReader(httpJsonRpc(rpcUrl));
  return unsupportedReader(chain);
}

/** Whether an activation is about this chain. A feature account names the Solana namespace: every cluster. */
export function appliesTo(activation: Activation, chain: string): boolean {
  return activation.chain === chain || activation.chain === namespaceOf(chain);
}

export interface ActivationReading {
  entry: string;
  rev: number;
  subject: string;
  activation: Activation;
  status: ActivationState;
}

export interface ChainReading {
  /** The CAIP-2 id of the chain that answered. */
  chain: string;
  /** What showed which chain answered: its genesis block, only the chain id it states, or the name asked for. */
  identifiedBy: 'genesis' | 'chain-id' | 'asked';
  /** The name people use for it, when there is one. */
  name?: string;
  point: ReadingPoint;
  activations: ActivationReading[];
  /** Entries that say nothing about this chain, and why — never silently left out. */
  withoutActivation: { entry: string; reason: string }[];
}

/**
 * The state of every activation the entries name on one chain. An endpoint that serves another chain than the
 * one asked for is an error, not a reading: the answer would be about the wrong network.
 */
export async function readActivations(
  entries: Entry[],
  reader: ActivationReader,
  asked?: string,
): Promise<ChainReading> {
  const { chain, by } = await reader.identify();
  if (asked !== undefined && asked !== chain) throw new Error(`the endpoint serves ${chain}, not ${asked}`);
  const wanted = entries.flatMap((entry) =>
    activationsOf(entry)
      .filter((activation) => appliesTo(activation, chain))
      .map((activation) => ({ entry, activation })),
  );
  const { point, states } =
    wanted.length === 0
      ? { point: {}, states: [] }
      : await reader.read(wanted.map(({ activation }) => activation));
  const withoutActivation = entries
    .filter((entry) => !activationsOf(entry).some((activation) => appliesTo(activation, chain)))
    .map((entry) => {
      const elsewhere = [...new Set(activationsOf(entry).map((activation) => activation.chain))];
      return {
        entry: entry.id,
        reason:
          elsewhere.length === 0
            ? 'no activation on any chain: it applies by version range'
            : `no activation on this chain; it activates on ${elsewhere.join(', ')}`,
      };
    });
  const name = chainNameOf(chain);
  return {
    chain,
    identifiedBy: by,
    ...(name === undefined ? {} : { name }),
    point,
    activations: wanted.map(({ entry, activation }, index) => ({
      entry: entry.id,
      rev: entry.rev,
      subject: subjectOf(entry).name,
      activation,
      status: states[index] ?? { state: 'unknown', reason: 'no state returned for this activation' },
    })),
    withoutActivation,
  };
}
