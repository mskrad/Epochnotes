import { CLUSTERS, type OnchainCluster } from '@epochnotes/core';
import { Option } from 'commander';

const ENDPOINTS: Record<string, string> = { ...CLUSTERS, localnet: 'http://127.0.0.1:8899' };

/** Exit codes shared by every command: 0 ok, 1 findings or invalid data, 2 environment or usage error. */
export const EXIT = { ok: 0, findings: 1, environment: 2 } as const;

/** The one `--cluster` option all commands share; only its default differs. */
export const clusterOption = (defaultCluster: string) =>
  new Option('--cluster <name>', 'cluster').choices(Object.keys(ENDPOINTS)).default(defaultCluster);

export const rpcUrlOption = () =>
  new Option('--rpc-url <url>', 'JSON-RPC endpoint instead of the public one');

export function rpcUrlOf(options: { cluster: string; rpcUrl?: string }): string {
  return options.rpcUrl ?? (ENDPOINTS[options.cluster] as string);
}

export function clusterOf(options: { cluster: string; rpcUrl?: string }): OnchainCluster {
  const rpcUrl = rpcUrlOf(options);
  const wsUrl = rpcUrl.startsWith('http://127.0.0.1:8899')
    ? 'ws://127.0.0.1:8900'
    : rpcUrl.replace(/^http/, 'ws');
  return { rpcUrl, wsUrl };
}
