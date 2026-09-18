import { ENTRY_SCHEMA_VERSION } from '@epochnotes/core';
import { Command } from 'commander';

export const CLI_VERSION = '0.0.0';

/** Builds the command tree. Commands stay thin: logic lives in `@epochnotes/core`. */
export function buildProgram(): Command {
  return new Command('epochnotes')
    .description('Signed registry of Solana network changes and the checks built on it.')
    .version(`${CLI_VERSION} (entry schema ${ENTRY_SCHEMA_VERSION})`);
}
