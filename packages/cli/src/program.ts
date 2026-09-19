import { createRequire } from 'node:module';

import { ENTRY_SCHEMA_VERSION } from '@epochnotes/core';
import { Command } from 'commander';

import { checkCommand } from './check.js';
import { registryCommand } from './registry.js';
import { rentCommand } from './rent.js';
import { statusCommand } from './status.js';

/** The version lives in package.json only. */
export const CLI_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** Usage errors must not end the process with 1: that code means "findings". The caller decides (see main.ts). */
function throwOnUsageErrors(command: Command): Command {
  command.exitOverride();
  command.commands.forEach(throwOnUsageErrors);
  return command;
}

/** Builds the command tree. Commands stay thin: logic lives in `@epochnotes/core`. */
export function buildProgram(): Command {
  return throwOnUsageErrors(
    new Command('epochnotes')
      .description('Signed registry of Solana network changes and the checks built on it.')
      .version(`${CLI_VERSION} (entry schema ${ENTRY_SCHEMA_VERSION})`)
      .addCommand(registryCommand())
      .addCommand(statusCommand())
      .addCommand(checkCommand())
      .addCommand(rentCommand()),
  );
}
