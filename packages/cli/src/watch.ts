import { watchReportMarkdown, watchSolanaFiles } from '@epochnotes/core';
import { Command } from 'commander';

import { EXIT } from './cluster.js';
import { reportError } from './output.js';

export function watchCommand(): Command {
  const watch = new Command('watch').description(
    'Look for what changed on a chain since the last look, and draft what the registry does not cover yet.',
  );
  watch
    .command('solana')
    .description(
      'Read the feature gates agave declares and their state on mainnet-beta, testnet and devnet; compare with the last snapshot; draft entries for what moved outside the registry. Reads only.',
    )
    .option(
      '--state <file>',
      'the snapshot of the last look; read if present, then replaced',
      'watch/state.json',
    )
    .option('--out <dir>', 'where to write report.json, report.md and drafts/', 'watch')
    .option('--registry <dir>', 'entries to tell a covered gate from an uncovered one', 'registry/entries')
    .option('--agave-ref <commit>', "agave commit to read instead of the default branch's head")
    .option('--json', 'print the report as JSON')
    .action(
      async (options: {
        state: string;
        out: string;
        registry: string;
        agaveRef?: string;
        json?: boolean;
      }) => {
        try {
          const report = await watchSolanaFiles(options);
          if (options.json) console.log(JSON.stringify(report, null, 2));
          else process.stdout.write(watchReportMarkdown(report));
          process.exitCode = EXIT.ok;
        } catch (error) {
          reportError(options.json, 'watch Solana', error);
        }
      },
    );
  return watch;
}
