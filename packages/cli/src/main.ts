import { CommanderError } from 'commander';

import { EXIT } from './cluster.js';
import { buildProgram } from './program.js';

/**
 * Runs the CLI and returns its exit code. This is the whole entry point — `bin.ts` only forwards to it — so
 * tests that call it exercise exactly what a user runs.
 */
export async function main(argv: string[]): Promise<number> {
  process.exitCode = undefined;
  // Options are not parsed yet when a usage error happens, so the flag is looked up by hand.
  const json = argv.includes('--json');
  try {
    await buildProgram().parseAsync(argv);
    return Number(process.exitCode ?? EXIT.ok);
  } catch (error) {
    // --help and --version end with 0; every other commander error is a usage error, never "findings".
    if (error instanceof CommanderError && error.exitCode === 0) return EXIT.ok;
    const message = error instanceof Error ? error.message : String(error);
    const text =
      error instanceof CommanderError
        ? `Usage error: ${message}`
        : `epochnotes failed unexpectedly: ${message}`;
    // Commander has already written its own message to stderr; an unforeseen failure has not been reported yet.
    if (json) console.log(JSON.stringify({ ok: false, error: text }, null, 2));
    else if (!(error instanceof CommanderError)) console.error(text);
    // Node would end an uncaught failure with 1, which here means "findings".
    return EXIT.environment;
  }
}
