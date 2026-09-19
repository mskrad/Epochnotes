import { CommanderError } from 'commander';

import { EXIT } from './cluster.js';
import { buildProgram } from './program.js';

try {
  await buildProgram().parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  // --help and --version end with 0; every other commander error is a usage error, never "findings".
  process.exitCode = error.exitCode === 0 ? EXIT.ok : EXIT.environment;
}
