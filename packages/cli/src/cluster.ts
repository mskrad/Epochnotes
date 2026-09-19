import { clusterFromRpcUrl, CLUSTERS, type OnchainCluster } from '@epochnotes/core';
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

export function clusterOf(options: { cluster: string; rpcUrl?: string }): OnchainCluster {
  return clusterFromRpcUrl(rpcUrlOf(options));
}
