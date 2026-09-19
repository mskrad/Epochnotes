import {
  type CheckReport,
  checkDirectory,
  checkRepository,
  type Provenance,
  readRegistry,
  readTrustedPublishers,
} from '@epochnotes/core';
import { Command, Option } from 'commander';

import { EXIT } from './cluster.js';
import { reportError, reportIssues } from './output.js';
import { addRpcCheckCommand } from './read.js';

interface RepoOptions {
  registry: string;
  versions?: string;
  publishers: string;
  json?: boolean;
}

const UNSIGNED =
  'These rules were read from files that nobody signed. Pass --versions to take them from a verified version.';

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
    .option('--registry <path>', 'directory of unsigned registry entries', 'registry/entries')
    .addOption(
      new Option(
        '--versions <dir-or-url>',
        'take the rules from the latest verified version of this log instead of --registry',
      ).env('EPOCHNOTES_VERSIONS'),
    )
    .addOption(
      new Option('--publishers <file>', 'trusted publishers, with --versions')
        .default('registry/publishers.json')
        .env('EPOCHNOTES_PUBLISHERS'),
    )
    .option('--json', 'print the report as JSON')
    .action(async (path: string, options: RepoOptions) => {
      let report: CheckReport;
      let provenance: Provenance | undefined;
      try {
        if (options.versions === undefined) {
          report = checkRepository(path, options.registry);
          provenance = { verified: false, workingCopy: options.registry, warning: UNSIGNED };
        } else {
          const reading = await readRegistry({
            log: {
              versionsDir: options.versions,
              trustedPublishers: readTrustedPublishers(options.publishers),
            },
          });
          if (!reading.ok) return reportIssues(options.json, reading.issues);
          provenance = reading.provenance;
          report = checkDirectory(
            path,
            reading.entries.map(({ entry }) => entry),
          );
        }
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
      if (options.json) console.log(JSON.stringify({ provenance, ...report }, null, 2));
      else {
        console.log(
          provenance?.verified
            ? `rules from verified version ${provenance.version} of ${provenance.publisher}`
            : `UNVERIFIED rules from the unsigned files in ${options.registry}; pass --versions to use a signed version`,
        );
        print(report);
      }
      process.exitCode = report.findings.some((finding) => finding.confidence === 'breaks')
        ? EXIT.findings
        : EXIT.ok;
    });
  addRpcCheckCommand(check);
  return check;
}
