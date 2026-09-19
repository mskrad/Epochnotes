import {
  admitPublisher,
  anchorLog,
  CLUSTERS,
  type OnchainCluster,
  revokeEntryOnChain,
} from '@epochnotes/core';
import { type Command, Option } from 'commander';

import { EXIT } from './registry.js';

const ENDPOINTS: Record<string, string> = { ...CLUSTERS, localnet: 'http://127.0.0.1:8899' };
/** Writing is limited to clusters with no value at stake; mainnet is a decision for the project owner. */
const WRITABLE = new Set(['devnet', 'localnet']);

export const clusterOption = () =>
  new Option('--cluster <name>', 'cluster').choices(Object.keys(ENDPOINTS)).default('devnet');

export function clusterOf(options: { cluster: string; rpcUrl?: string }): OnchainCluster {
  const rpcUrl = options.rpcUrl ?? (ENDPOINTS[options.cluster] as string);
  const wsUrl = rpcUrl.startsWith('http://127.0.0.1:8899')
    ? 'ws://127.0.0.1:8900'
    : rpcUrl.replace(/^http/, 'ws');
  return { rpcUrl, wsUrl };
}

function refuseWrites(cluster: string): boolean {
  if (WRITABLE.has(cluster)) return false;
  console.error(`Writing to ${cluster} is not allowed: this tool writes to devnet and localnet only.`);
  process.exitCode = EXIT.environment;
  return true;
}

/** A failed transaction hides its reason in the cause chain ("Custom program error: #6000"): print all of it. */
function fail(error: unknown, what: string): void {
  const reasons: string[] = [];
  for (let at: unknown = error; at instanceof Error && reasons.length < 5; at = at.cause)
    reasons.push(at.message);
  console.error(`Cannot ${what}: ${reasons.join(' <- ')}`);
  process.exitCode = EXIT.environment;
}

const printIssues = (issues: { path: string; message: string; hint: string }[]) => {
  for (const issue of issues)
    console.error(`FAIL  ${issue.path}: ${issue.message}\n        fix: ${issue.hint}`);
  process.exitCode = EXIT.findings;
};

/** Adds the on-chain commands to `registry`: `anchor`, `admit`, and the check behind `verify --onchain`. */
export function addChainCommands(registry: Command): void {
  registry
    .command('anchor')
    .description('Write to chain every version of the log that is not there yet.')
    .requiredOption('--key <file>', 'publisher keypair; it signs and pays for the transactions')
    .option('--versions <dir>', 'directory of the version log', 'registry/versions')
    .addOption(clusterOption())
    .option('--rpc-url <url>', 'JSON-RPC endpoint instead of the public one')
    .option('--json', 'print the result as JSON')
    .action(
      async (options: {
        key: string;
        versions: string;
        cluster: string;
        rpcUrl?: string;
        json?: boolean;
      }) => {
        if (refuseWrites(options.cluster)) return;
        try {
          const result = await anchorLog({
            versionsDir: options.versions,
            keyFile: options.key,
            cluster: clusterOf(options),
          });
          if (!result.ok) return printIssues(result.issues);
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(
              `Publisher account ${result.publisher} on ${options.cluster}; ${result.alreadyOnChain} version(s) were already on chain.`,
            );
            for (const version of result.anchored)
              console.log(
                `  anchored version ${version.n}  root ${version.merkleRoot}\n    account   ${version.address}\n    signature ${version.signature}`,
              );
            if (result.anchored.length === 0) console.log('  nothing to anchor: the chain is up to date.');
          }
          process.exitCode = EXIT.ok;
        } catch (error) {
          fail(error, 'anchor the log');
        }
      },
    );

  registry
    .command('revoke')
    .description('Record on chain that the publisher withdrew an entry. It cannot be undone.')
    .requiredOption('--key <file>', 'publisher keypair; it signs and pays')
    .requiredOption('--entry <id>', 'id of the entry to withdraw')
    .addOption(clusterOption())
    .option('--rpc-url <url>', 'JSON-RPC endpoint instead of the public one')
    .action(async (options: { key: string; entry: string; cluster: string; rpcUrl?: string }) => {
      if (refuseWrites(options.cluster)) return;
      try {
        const result = await revokeEntryOnChain({
          keyFile: options.key,
          entryId: options.entry,
          cluster: clusterOf(options),
        });
        console.log(
          `Revoked ${options.entry} on ${options.cluster}\n  account   ${result.address}\n  signature ${result.signature}`,
        );
        process.exitCode = EXIT.ok;
      } catch (error) {
        fail(error, 'revoke the entry');
      }
    });

  registry
    .command('admit')
    .description('As the registry admin, admit a publisher key (creates the registry on first use).')
    .requiredOption('--admin-key <file>', 'admin keypair; it signs and pays')
    .requiredOption('--publisher <address>', 'public key of the publisher to admit')
    .requiredOption('--name <name>', 'publisher name, up to 32 bytes')
    .addOption(clusterOption())
    .option('--rpc-url <url>', 'JSON-RPC endpoint instead of the public one')
    .action(
      async (options: {
        adminKey: string;
        publisher: string;
        name: string;
        cluster: string;
        rpcUrl?: string;
      }) => {
        if (refuseWrites(options.cluster)) return;
        try {
          const result = await admitPublisher({
            adminKeyFile: options.adminKey,
            publisher: options.publisher,
            name: options.name,
            cluster: clusterOf(options),
          });
          console.log(
            `${result.initialized ? 'Created the registry and admitted' : 'Admitted'} ${options.name} on ${options.cluster}`,
          );
          console.log(`  config    ${result.config}\n  publisher ${result.publisher}`);
          for (const signature of result.signatures) console.log(`  signature ${signature}`);
          process.exitCode = EXIT.ok;
        } catch (error) {
          fail(error, 'admit the publisher');
        }
      },
    );
}
