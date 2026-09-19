import {
  compareLogWithChain,
  fetchRevocation,
  parsePin,
  publishVersion,
  readTrustedPublishers,
  verifyEntry,
} from '@epochnotes/core';
import type { Command } from 'commander';

import { clusterOf, clusterOption, EXIT, rpcUrlOption } from './cluster.js';
import { reportError, reportIssues } from './output.js';

interface Paths {
  entries: string;
  versions: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Adds `publish` and `verify` to the `registry` command. */
export function addVersionCommands(registry: Command): void {
  registry
    .command('publish')
    .description('Sign the entries on disk as the next version of the publisher log.')
    .requiredOption(
      '--key <file>',
      'publisher keypair (solana-keygen format); keep it outside the repository',
    )
    .option('--entries <dir>', 'directory of registry entries', 'registry/entries')
    .option('--versions <dir>', 'directory of the version log', 'registry/versions')
    .option(
      '--uri <uri>',
      'where the content will be served; {root} is the Merkle root',
      'registry/versions/{root}.jsonl',
    )
    .option('--revoke <id...>', 'entries deliberately removed in this version')
    .option('--dry-run', 'build and sign, but write nothing')
    .option('--json', 'print the result as JSON')
    .action(
      async (
        options: Paths & { key: string; uri: string; revoke?: string[]; dryRun?: boolean; json?: boolean },
      ) => {
        let result;
        try {
          result = await publishVersion({
            entriesDir: options.entries,
            versionsDir: options.versions,
            keyFile: options.key,
            uri: options.uri,
            published: today(),
            ...(options.revoke === undefined ? {} : { revoke: options.revoke }),
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          });
        } catch (error) {
          reportError(options.json, 'publish', error);
          return;
        }
        if (!result.ok) return reportIssues(options.json, result.issues);
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else if (!result.published)
          console.log(
            `Nothing to publish: the entries equal version ${result.manifest.n} (root ${result.manifest.merkle_root}).`,
          );
        else {
          const { manifest } = result;
          console.log(
            `${result.dryRun ? 'Would publish' : 'Published'} version ${manifest.n} by ${manifest.publisher}`,
          );
          console.log(
            `  root      ${manifest.merkle_root}\n  prev_root ${manifest.prev_root}\n  entries   ${manifest.entry_count}\n  uri       ${manifest.uri}`,
          );
          if (manifest.revoked.length > 0) console.log(`  revoked   ${manifest.revoked.join(', ')}`);
          for (const file of result.files)
            console.log(`  ${result.dryRun ? 'would write' : 'wrote'} ${file}`);
        }
        process.exitCode = EXIT.ok;
      },
    );

  registry
    .command('verify')
    .description('Prove that an entry belongs to the latest signed version, without trusting the server.')
    .argument('<entry-id>', 'id of the entry, for example tx-v1')
    .option(
      '--versions <dir-or-url>',
      'directory of the version log, or the base URL of a host that serves it',
      'registry/versions',
    )
    .option('--publishers <file>', 'trusted publishers', 'registry/publishers.json')
    .option('--mirror <url...>', 'hash-addressed mirrors tried after the manifest uri')
    .option('--pin <n:root>', 'the version seen last time; detects a rolled-back or rewritten log')
    .option('--onchain', 'also compare the log with the chain: catches a truncated or rewritten log')
    .addOption(clusterOption('devnet'))
    .addOption(rpcUrlOption())
    .option('--json', 'print the result as JSON, including the Merkle proof')
    .action(
      async (
        entryId: string,
        options: {
          versions: string;
          publishers: string;
          mirror?: string[];
          pin?: string;
          onchain?: boolean;
          cluster: string;
          rpcUrl?: string;
          json?: boolean;
        },
      ) => {
        const pin = options.pin === undefined ? undefined : parsePin(options.pin);
        if (options.pin !== undefined && pin === undefined) {
          reportError(
            options.json,
            'read --pin',
            new Error('it must look like 3:<64 hex characters>, as printed by a previous verify'),
          );
          return;
        }
        let result;
        try {
          result = await verifyEntry({
            versionsDir: options.versions,
            trustedPublishers: readTrustedPublishers(options.publishers),
            entryId,
            ...(options.mirror === undefined ? {} : { mirrors: options.mirror }),
            ...(pin === undefined ? {} : { pin }),
          });
        } catch (error) {
          reportError(options.json, 'verify', error);
          return;
        }
        if (!result.ok) return reportIssues(options.json, result.issues);
        let chain = 'not checked (pass --onchain)';
        if (options.onchain) {
          let differences;
          try {
            differences = await compareLogWithChain(clusterOf(options), result.log);
            // The log can be intact and the entry still withdrawn: a revocation is a record of its own on chain.
            const revoked = await fetchRevocation(clusterOf(options), result.manifest.publisher, entryId);
            if (revoked !== undefined) {
              differences.push({
                path: entryId,
                message: `Entry was revoked on chain by its publisher (at version ${revoked.atVersion})`,
                hint: 'Do not rely on this entry. The revocation account is ' + revoked.address + '.',
              });
            }
          } catch (error) {
            reportError(options.json, 'verify', error);
            return;
          }
          if (differences.length > 0) return reportIssues(options.json, differences);
          chain = `${result.versions} version(s) match the ${options.cluster} program: count, roots, content hashes`;
        }
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          const { manifest, proof } = result;
          console.log(
            `OK    ${proof.entry.id}@${proof.entry.rev} is in version ${manifest.n} of ${manifest.publisher}`,
          );
          console.log(
            `  leaf      ${proof.leaf}\n  root      ${manifest.merkle_root}  (signed; ${proof.proof.length}-step Merkle proof)`,
          );
          console.log(
            `  log       ${result.versions} version(s), signatures and prev_root chain verified\n  content   ${result.contentSource} (sha256 matches the manifest)`,
          );
          console.log(`  chain     ${chain}`);
          console.log(`  pin       ${manifest.n}:${manifest.merkle_root}`);
          // The chain already answers what a pin is for: whether the log is complete and unforked.
          if (!options.onchain) {
            console.log(
              '  note      signatures prove the log is consistent, not complete: pass --pin next time to detect a rollback.',
            );
          }
        }
        process.exitCode = EXIT.ok;
      },
    );
}
