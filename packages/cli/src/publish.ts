import { publishVersion, readTrustedPublishers, verifyEntry } from '@epochnotes/core';
import type { Command } from 'commander';

import { EXIT } from './registry.js';

interface Paths {
  entries: string;
  versions: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function fail(issues: { path: string; message: string; hint: string }[]): void {
  for (const issue of issues)
    console.error(`FAIL  ${issue.path}: ${issue.message}\n        fix: ${issue.hint}`);
  process.exitCode = EXIT.findings;
}

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
          console.error(`Cannot publish: ${(error as Error).message}`);
          process.exitCode = EXIT.environment;
          return;
        }
        if (!result.ok) return fail(result.issues);
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
    .option('--versions <dir>', 'directory of the version log', 'registry/versions')
    .option('--publishers <file>', 'trusted publishers', 'registry/publishers.json')
    .option('--mirror <url...>', 'hash-addressed mirrors tried after the manifest uri')
    .option('--json', 'print the result as JSON, including the Merkle proof')
    .action(
      async (
        entryId: string,
        options: { versions: string; publishers: string; mirror?: string[]; json?: boolean },
      ) => {
        let result;
        try {
          result = await verifyEntry({
            versionsDir: options.versions,
            trustedPublishers: readTrustedPublishers(options.publishers),
            entryId,
            ...(options.mirror === undefined ? {} : { mirrors: options.mirror }),
          });
        } catch (error) {
          console.error(`Cannot verify: ${(error as Error).message}`);
          process.exitCode = EXIT.environment;
          return;
        }
        if (!result.ok) return fail(result.issues);
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
        }
        process.exitCode = EXIT.ok;
      },
    );
}
