/**
 * Chain identity. Every chain is named by its CAIP-2 id (`<namespace>:<reference>`), whatever the name a user
 * passes: a name says nothing about where an endpoint leads, an id read from the endpoint does.
 *
 * For Solana the reference is the first 32 characters of the genesis hash (ChainAgnostic/namespaces,
 * `solana/caip2.md`). This module imports nothing from the rest of the library, so the entry schema can use it.
 */

/** Solana clusters by genesis hash. */
export const GENESIS = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as const;

export type SolanaCluster = keyof typeof GENESIS;

/** The CAIP-2 id of a Solana chain from its genesis hash. */
export function solanaChainId(genesisHash: string): string {
  return `solana:${genesisHash.slice(0, 32)}`;
}

/** CAIP-2 ids of the Solana clusters this library knows, by the names users pass. */
export const SOLANA_CHAINS = Object.fromEntries(
  Object.entries(GENESIS).map(([cluster, hash]) => [cluster, solanaChainId(hash)]),
) as Record<SolanaCluster, string>;

/** CAIP-2: a namespace of 3–8 characters and a reference of up to 32. */
export const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export function namespaceOf(chain: string): string {
  return chain.split(':')[0] ?? chain;
}

/** The cluster name of a known Solana CAIP-2 id, for messages people read. */
export function solanaClusterOf(chain: string): SolanaCluster | undefined {
  return (Object.entries(SOLANA_CHAINS) as [SolanaCluster, string][]).find(([, id]) => id === chain)?.[0];
}
