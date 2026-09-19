import {
  type FeatureState,
  registryStatus,
  rpcFeatureAccountSource,
  type StatusReport,
} from '@epochnotes/core';
import { Command } from 'commander';

import { clusterOption, EXIT, rpcUrlOf, rpcUrlOption } from './cluster.js';
import { reportError } from './output.js';

function describe(status: FeatureState): string {
  switch (status.state) {
    case 'active':
      return `active since slot ${status.activatedAt}`;
    case 'pending':
      return 'pending (activates on an epoch boundary)';
    case 'absent':
      return 'absent (no feature account: not scheduled)';
    case 'unreadable':
      return `unreadable: ${status.reason}`;
  }
}

function print(report: StatusReport): void {
  if (!report.ok && report.kind === 'registry') {
    console.error('The registry is not valid; run `epochnotes registry validate` for details.');
    for (const issue of report.issues) console.error(`  ${issue.path}: ${issue.message}`);
    return;
  }
  if (!report.ok) {
    console.error(`Cluster ${report.cluster} did not answer: ${report.error}`);
    console.error('  fix: check the network, or pass another endpoint with --rpc-url.');
    return;
  }
  console.log(`cluster ${report.cluster}, read at slot ${report.slot}`);
  let current = '';
  for (const gate of report.gates) {
    if (gate.entry !== current) console.log(`\n${gate.entry}@${gate.rev}  ${gate.subject}`);
    current = gate.entry;
    console.log(`  ${gate.label.padEnd(34)} ${gate.address.padEnd(44)}  ${describe(gate.status)}`);
  }
  for (const entry of report.withoutGates)
    console.log(`\n${entry}  no feature gate: applies by version range`);
}

export function statusCommand(): Command {
  return new Command('status')
    .description('Show, from the network itself, which registry changes are active on a cluster.')
    .addOption(clusterOption('mainnet-beta'))
    .addOption(rpcUrlOption())
    .option('--registry <path>', 'directory of registry entries', 'registry/entries')
    .option('--json', 'print the report as JSON')
    .action(async (options: { cluster: string; rpcUrl?: string; registry: string; json?: boolean }) => {
      let report: StatusReport;
      try {
        const source = rpcFeatureAccountSource(rpcUrlOf(options));
        report = await registryStatus(options.registry, options.cluster, source);
      } catch (error) {
        reportError(options.json, `read the registry at ${options.registry}`, error);
        return;
      }
      if (options.json) {
        // Slots are 64-bit: printed as decimal strings so no JSON reader rounds them.
        console.log(
          JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
        );
      } else print(report);
      process.exitCode = report.ok ? EXIT.ok : report.kind === 'registry' ? EXIT.findings : EXIT.environment;
    });
}
