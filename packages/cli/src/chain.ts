import {
  admitPublisher,
  anchorLog,
  redactUrl,
  revokeEntryOnChain,
  setPublisherActiveOnChain,
} from '@epochnotes/core';
import type { Command } from 'commander';

import { clusterOf, clusterOption, EXIT, rpcUrlOption } from './cluster.js';

interface ChainOptions {
  cluster: string;
  rpcUrl?: string;
  json?: boolean;
}

/** A failed transaction hides its reason in the cause chain ("Custom program error: #6000"): print all of it. */
function fail(error: unknown, what: string): void {
  const reasons: string[] = [];
  for (let at: unknown = error; at instanceof Error && reasons.length < 5; at = at.cause)
    reasons.push(at.message);
  // Transport errors quote the endpoint, and provider API keys travel in its path or query.
  const text = reasons.join(' <- ').replace(/https?:\/\/[^\s'"]+/g, (url) => redactUrl(url));
  console.error(`Cannot ${what}: ${text}`);
  process.exitCode = EXIT.environment;
}

const printIssues = (issues: { path: string; message: string; hint: string }[]) => {
  for (const issue of issues)
    console.error(`FAIL  ${issue.path}: ${issue.message}\n        fix: ${issue.hint}`);
  process.exitCode = EXIT.findings;
};

/** Every chain command takes the same cluster options and can print JSON. Writes are gated in core by genesis hash. */
const chainCommand = (registry: Command, name: string, description: string) =>
  registry
    .command(name)
    .description(description)
    .addOption(clusterOption('devnet'))
    .addOption(rpcUrlOption())
    .option('--json', 'print the result as JSON');

/** Adds the on-chain commands to `registry`. */
export function addChainCommands(registry: Command): void {
  chainCommand(registry, 'anchor', 'Write to chain every version of the log that is not there yet.')
    .requiredOption('--key <file>', 'publisher keypair; it signs and pays for the transactions')
    .option('--versions <dir>', 'directory of the version log', 'registry/versions')
    .action(async (options: ChainOptions & { key: string; versions: string }) => {
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
          for (const version of result.anchored) {
            console.log(
              `  anchored version ${version.n}  root ${version.merkleRoot}\n    account   ${version.address}\n    signature ${version.signature}`,
            );
          }
          if (result.anchored.length === 0) console.log('  nothing to anchor: the chain is up to date.');
        }
        process.exitCode = EXIT.ok;
      } catch (error) {
        fail(error, 'anchor the log');
      }
    });

  chainCommand(
    registry,
    'revoke',
    'Record on chain that the publisher withdrew an entry. It cannot be undone.',
  )
    .requiredOption('--key <file>', 'publisher keypair; it signs and pays')
    .requiredOption('--entry <id>', 'id of the entry to withdraw')
    .option('--yes', 'confirm: a revocation is permanent')
    .action(async (options: ChainOptions & { key: string; entry: string; yes?: boolean }) => {
      if (options.yes !== true) {
        console.error(
          `Revoking ${options.entry} is permanent: the id can never be published again. Re-run with --yes to confirm.`,
        );
        process.exitCode = EXIT.environment;
        return;
      }
      try {
        const result = await revokeEntryOnChain({
          keyFile: options.key,
          entryId: options.entry,
          cluster: clusterOf(options),
        });
        if (options.json) console.log(JSON.stringify({ entry: options.entry, ...result }, null, 2));
        else
          console.log(
            `Revoked ${options.entry} on ${options.cluster}\n  account   ${result.address}\n  signature ${result.signature}`,
          );
        process.exitCode = EXIT.ok;
      } catch (error) {
        fail(error, 'revoke the entry');
      }
    });

  chainCommand(
    registry,
    'admit',
    'As the registry admin, admit a publisher key (creates the registry on first use).',
  )
    .requiredOption('--admin-key <file>', 'admin keypair; it signs and pays')
    .requiredOption('--publisher <address>', 'public key of the publisher to admit')
    .requiredOption('--name <name>', 'publisher name, up to 32 bytes')
    .action(async (options: ChainOptions & { adminKey: string; publisher: string; name: string }) => {
      try {
        const result = await admitPublisher({
          adminKeyFile: options.adminKey,
          publisher: options.publisher,
          name: options.name,
          cluster: clusterOf(options),
        });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(
            `${result.initialized ? 'Created the registry and admitted' : 'Admitted'} ${options.name} on ${options.cluster}`,
          );
          console.log(`  config    ${result.config}\n  publisher ${result.publisher}`);
          for (const signature of result.signatures) console.log(`  signature ${signature}`);
        }
        process.exitCode = EXIT.ok;
      } catch (error) {
        fail(error, 'admit the publisher');
      }
    });

  for (const [name, active, description] of [
    [
      'suspend',
      false,
      'As the registry admin, stop vouching for a publisher: clients then refuse its whole log.',
    ],
    ['restore', true, 'As the registry admin, vouch for a suspended publisher again.'],
  ] as const) {
    chainCommand(registry, name, description)
      .requiredOption('--admin-key <file>', 'admin keypair; it signs and pays')
      .requiredOption('--publisher <address>', 'public key of the publisher')
      .action(async (options: ChainOptions & { adminKey: string; publisher: string }) => {
        try {
          const result = await setPublisherActiveOnChain({
            adminKeyFile: options.adminKey,
            publisher: options.publisher,
            active,
            cluster: clusterOf(options),
          });
          if (options.json)
            console.log(JSON.stringify({ publisher: options.publisher, active, ...result }, null, 2));
          else
            console.log(
              `${active ? 'Restored' : 'Suspended'} ${options.publisher} on ${options.cluster}\n  account   ${result.address}\n  signature ${result.signature}`,
            );
          process.exitCode = EXIT.ok;
        } catch (error) {
          fail(error, `${name} the publisher`);
        }
      });
  }
}
