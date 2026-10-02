import {
  CAIP2_PATTERN,
  clusterFromRpcUrl,
  CLUSTERS,
  type OnchainCluster,
  SOLANA_CHAINS,
} from '@epochnotes/core';
import { Option } from 'commander';

/** Exit codes shared by every command: 0 ok, 1 findings or invalid data, 2 environment or usage error. */
export const EXIT = { ok: 0, findings: 1, environment: 2 } as const;

/** The one `--cluster` option all commands share; only its default differs. */
export const clusterOption = (defaultCluster: string) =>
  new Option('--cluster <name>', 'cluster').choices(Object.keys(CLUSTERS)).default(defaultCluster);

export const rpcUrlOption = () =>
  new Option('--rpc-url <url>', 'JSON-RPC endpoint instead of the public one');

export function rpcUrlOf(options: { cluster: string; rpcUrl?: string }): string {
  return options.rpcUrl ?? CLUSTERS[options.cluster as keyof typeof CLUSTERS];
}

/**
 * For commands whose own `--cluster` / `--rpc-url` mean something else (the endpoint being probed, the cluster
 * being measured): where the registry program lives gets its own pair of options.
 */
export const registryClusterOption = () =>
  new Option('--registry-cluster <name>', 'with --onchain: cluster of the registry program')
    .choices(Object.keys(CLUSTERS))
    .default('devnet');

export const registryRpcUrlOption = () =>
  new Option(
    '--registry-rpc-url <url>',
    'with --onchain: JSON-RPC endpoint of that cluster instead of the public one',
  );

export function registryClusterOf(options: {
  registryCluster: string;
  registryRpcUrl?: string;
}): OnchainCluster {
  return clusterFromRpcUrl(
    options.registryRpcUrl ?? CLUSTERS[options.registryCluster as keyof typeof CLUSTERS],
  );
}

export function clusterOf(options: { cluster: string; rpcUrl?: string }): OnchainCluster {
  return clusterFromRpcUrl(rpcUrlOf(options));
}

/**
 * Names people use for chains. Each resolves to a CAIP-2 id before anything is read, and the endpoint is asked
 * which chain it serves anyway. `localnet` has no fixed id: its genesis is whatever the local validator made.
 */
const CHAIN_ALIASES: Record<string, { chain?: string; rpcUrl: string }> = {
  'mainnet-beta': { chain: SOLANA_CHAINS['mainnet-beta'], rpcUrl: CLUSTERS['mainnet-beta'] },
  testnet: { chain: SOLANA_CHAINS.testnet, rpcUrl: CLUSTERS.testnet },
  devnet: { chain: SOLANA_CHAINS.devnet, rpcUrl: CLUSTERS.devnet },
  localnet: { rpcUrl: CLUSTERS.localnet },
};

/** Public read-only endpoints by CAIP-2 id. */
const DEFAULT_ENDPOINTS: Record<string, string> = Object.fromEntries(
  Object.values(CHAIN_ALIASES).flatMap((alias) =>
    alias.chain === undefined ? [] : [[alias.chain, alias.rpcUrl]],
  ),
);

export const chainOption = (flag = '--chain <id>', what = 'chain to read') =>
  new Option(flag, `${what}: a CAIP-2 id, or one of ${Object.keys(CHAIN_ALIASES).join(', ')}`);

/**
 * The chain a command reads, from what the user typed. `--chain` and the older `--cluster` name the same thing
 * and must not disagree. With neither, an endpoint given by `--rpc-url` is read as whatever chain it says it
 * serves — the report names it — and without an endpoint the default is Solana mainnet-beta. An unknown name
 * is a usage error, never a guess.
 */
export function chainFromOptions(options: { chain?: string; cluster?: string; rpcUrl?: string }): {
  chain?: string;
  rpcUrl?: string;
} {
  if (options.chain !== undefined && options.cluster !== undefined) {
    const [a, b] = [resolveChain(options.chain).chain, resolveChain(options.cluster).chain];
    if (a !== b || a === undefined)
      throw new UsageError(
        `--chain ${options.chain} and --cluster ${options.cluster} name different chains: pass one`,
      );
  }
  const name = options.chain ?? options.cluster;
  if (name === undefined)
    return options.rpcUrl === undefined ? resolveChain('mainnet-beta') : { rpcUrl: options.rpcUrl };
  return resolveChain(name, options.rpcUrl);
}

/** A chain name as the user typed it, resolved; an unknown name is a usage error, never a guess. */
export function resolveChain(name: string, rpcUrl?: string): { chain?: string; rpcUrl?: string } {
  const alias = CHAIN_ALIASES[name];
  if (alias !== undefined) return { ...alias, ...(rpcUrl === undefined ? {} : { rpcUrl }) };
  if (!CAIP2_PATTERN.test(name))
    throw new UsageError(
      `"${name}" is not a chain: pass a CAIP-2 id such as eip155:1, or one of ${Object.keys(CHAIN_ALIASES).join(', ')}`,
    );
  const endpoint = rpcUrl ?? DEFAULT_ENDPOINTS[name];
  // A Solana cluster this tool has no public endpoint for (a private one) is read only where the user says.
  if (endpoint === undefined && name.startsWith('solana:'))
    throw new UsageError(`no public endpoint is known for ${name}: pass one with --rpc-url`);
  return { chain: name, ...(endpoint === undefined ? {} : { rpcUrl: endpoint }) };
}

/** A mistake in what the user asked for: exit 2, like any other usage error. */
export class UsageError extends Error {}
