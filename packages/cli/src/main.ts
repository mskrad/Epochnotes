import { CommanderError } from 'commander';

import { EXIT } from './cluster.js';
import { buildProgram } from './program.js';

/**
 * Runs the CLI and returns its exit code. This is the whole entry point — `bin.ts` only forwards to it — so
 * tests that call it exercise exactly what a user runs.
 */
export async function main(argv: string[]): Promise<number> {
  process.exitCode = undefined;
  try {
    await buildProgram().parseAsync(argv);
    return Number(process.exitCode ?? EXIT.ok);
  } catch (error) {
    // --help and --version end with 0; every other commander error is a usage error, never "findings".
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.ok : EXIT.environment;
    // Anything else is a bug or an unforeseen environment failure. Node would exit with 1, which means "findings".
    console.error(
      `epochnotes failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT.environment;
  }
}
