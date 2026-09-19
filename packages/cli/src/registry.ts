import { type RegistryReport, validatePath } from '@epochnotes/core';
import { Command } from 'commander';

import { addChainCommands } from './chain.js';
import { EXIT } from './cluster.js';
import { reportError } from './output.js';
import { addVersionCommands } from './publish.js';
import { addReadCommand } from './read.js';

function printReport(report: RegistryReport): void {
  const inRegistryTrouble = (id?: string) =>
    report.registryIssues.some((issue) => issue.path === id || issue.path.startsWith(`${id}.`));
  for (const file of report.files) {
    if (file.ok && inRegistryTrouble(file.id)) {
      console.log(
        `FAIL  ${file.file}  ${file.id}@${file.rev}  (valid on its own; see registry problems below)`,
      );
      continue;
    }
    if (file.ok) {
      console.log(`OK    ${file.file}  ${file.id}@${file.rev}  leaf ${file.leaf}`);
      continue;
    }
    console.log(`FAIL  ${file.file}`);
    for (const issue of file.issues)
      console.log(`      ${issue.path || '(root)'}: ${issue.message}\n        fix: ${issue.hint}`);
  }
  for (const issue of report.registryIssues)
    console.log(`FAIL  registry ${issue.path}: ${issue.message}\n        fix: ${issue.hint}`);
}

export function registryCommand(): Command {
  const registry = new Command('registry').description('Work with registry entries and versions.');
  registry
    .command('validate')
    .description('Validate an entry file, or every entry in a directory together with cross-entry checks.')
    .argument('<path>', 'entry .yaml file or a directory of entries')
    .option('--json', 'print the report as JSON')
    .action((path: string, options: { json?: boolean }) => {
      let report: RegistryReport;
      try {
        report = validatePath(path);
      } catch (error) {
        reportError(options.json, `read ${path}`, error);
        return;
      }
      if (options.json) {
        // The JSON report is a summary; the parsed entries are for library callers only.
        const files = report.files.map(({ file, ok, id, rev, leaf, issues }) => ({
          file,
          ok,
          id,
          rev,
          leaf,
          issues,
        }));
        console.log(JSON.stringify({ ...report, files }, null, 2));
      } else printReport(report);
      process.exitCode = report.ok ? EXIT.ok : EXIT.findings;
    });
  addVersionCommands(registry);
  addReadCommand(registry);
  addChainCommands(registry);
  return registry;
}
