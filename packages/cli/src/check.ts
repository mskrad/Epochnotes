import { type CheckReport, checkRepository } from '@epochnotes/core';
import { Command } from 'commander';

import { EXIT } from './cluster.js';
import { reportError } from './output.js';

const LABEL = { breaks: 'BREAKS', check: 'CHECK ', 'likely-ok': 'OK?   ' } as const;

function print(report: Extract<CheckReport, { ok: true }>): void {
  for (const finding of report.findings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.log(`${LABEL[finding.confidence]} ${where}  [${finding.entry}@${finding.rev} ${finding.rule}]`);
    console.log(`       ${finding.excerpt}\n       ${finding.summary}`);
    for (const fix of finding.fix) console.log(`       fix: ${fix}`);
  }
  const breaking = report.findings.filter((finding) => finding.confidence === 'breaks').length;
  console.log(
    `${report.findings.length} finding(s), ${breaking} of them certain to break, in ${report.filesScanned} file(s) checked.`,
  );
  for (const rule of report.notRun) console.log(`not run: ${rule.entry} ${rule.rule} — ${rule.reason}`);
}

export function checkCommand(): Command {
  const check = new Command('check').description('Check code against the registry.');
  check
    .command('repo')
    .description('Find, in a repository, what the network changes in the registry will break.')
    .argument('<path>', 'directory of the repository')
    .option('--registry <path>', 'directory of registry entries', 'registry/entries')
    .option('--json', 'print the report as JSON')
    .action((path: string, options: { registry: string; json?: boolean }) => {
      let report: CheckReport;
      try {
        report = checkRepository(path, options.registry);
      } catch (error) {
        reportError(options.json, `check ${path}`, error);
        return;
      }
      if (!report.ok) {
        reportError(
          options.json,
          'use the registry',
          new Error('it is not valid; run `epochnotes registry validate` for details'),
        );
        return;
      }
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else print(report);
      process.exitCode = report.findings.some((finding) => finding.confidence === 'breaks')
        ? EXIT.findings
        : EXIT.ok;
    });
  return check;
}
