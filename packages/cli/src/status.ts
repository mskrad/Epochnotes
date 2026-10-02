import {
  type Activation,
  activationReaderFor,
  type ActivationState,
  type ReadingPoint,
  registryStatus,
  type StatusReport,
} from '@epochnotes/core';
import { Command, Option } from 'commander';

import { chainFromOptions, chainOption, EXIT, rpcUrlOption } from './cluster.js';
import { reportError } from './output.js';

function point(at: ReadingPoint): string {
  return [
    at.slot === undefined ? '' : `slot ${at.slot}`,
    at.block === undefined ? '' : `block ${at.block}`,
    at.time === undefined ? '' : `time ${at.time}`,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

const CONFIRMED: Record<Extract<ActivationState, { state: 'active' }>['confirmedBy'], string> = {
  'feature-account': 'the feature account says so',
  header: 'a block header shows it',
  node: 'the node reports it',
  'chain-data': 'a transaction of the chain shows it',
  'time-only': 'by time only: no block field shows it',
  'height-only': 'by height only: nothing else shows it',
};

/** One line for the state of an activation, the same in every command. */
export function describeActivation(status: ActivationState): string {
  switch (status.state) {
    case 'active':
      return `active since ${point(status.since)} (${CONFIRMED[status.confirmedBy]})`;
    case 'scheduled':
      return 'scheduled (known to the chain, not reached yet)';
    case 'absent':
      return 'absent (nothing scheduled on this chain)';
    case 'unknown':
      return `unknown: ${status.reason}`;
  }
}

/** Where an activation is to be found: an account address, or the time or height it was set for. */
export function whereOf(activation: Activation): string {
  switch (activation.kind) {
    case 'feature-account':
      return activation.address;
    case 'timestamp':
      return `at time ${activation.at}`;
    case 'block-height':
      return `at block ${activation.at}`;
  }
}

const IDENTIFIED: Record<'genesis' | 'chain-id' | 'asked', string> = {
  genesis: '',
  'chain-id': ', known by the chain id it states: its genesis block was not checked',
  asked: ', taken as named: nothing confirmed it',
};

export function readingLine(reading: {
  chain: string;
  name?: string;
  identifiedBy: 'genesis' | 'chain-id' | 'asked';
  point: ReadingPoint;
}): string {
  const name = `${reading.name === undefined ? '' : ` (${reading.name})`}${IDENTIFIED[reading.identifiedBy]}`;
  const at = point(reading.point);
  return `chain ${reading.chain}${name}${at === '' ? ', not read: see why below' : `, read at ${at}`}`;
}

function print(report: StatusReport): void {
  if (!report.ok && report.kind === 'registry') {
    console.error('The registry is not valid; run `epochnotes registry validate` for details.');
    for (const issue of report.issues) console.error(`  ${issue.path}: ${issue.message}`);
    return;
  }
  if (!report.ok) {
    console.error(`Cannot read chain ${report.chain}: ${report.error}`);
    console.error('  fix: check the network, or pass an endpoint of that chain with --rpc-url.');
    return;
  }
  console.log(readingLine(report));
  let current = '';
  for (const item of report.activations) {
    if (item.entry !== current) console.log(`\n${item.entry}@${item.rev}  ${item.subject}`);
    current = item.entry;
    console.log(
      `  ${item.activation.label.padEnd(34)} ${whereOf(item.activation).padEnd(44)}  ${describeActivation(item.status)}`,
    );
  }
  for (const item of report.withoutActivation) console.log(`\n${item.entry}  ${item.reason}`);
}

export function statusCommand(): Command {
  return new Command('status')
    .description('Show, from the network itself, which registry changes are active on a chain.')
    .addOption(chainOption())
    .addOption(new Option('--cluster <name>', 'the same as --chain, by cluster name').hideHelp())
    .addOption(rpcUrlOption())
    .option('--registry <path>', 'directory of registry entries', 'registry/entries')
    .option('--json', 'print the report as JSON')
    .action(
      async (options: {
        chain?: string;
        cluster?: string;
        rpcUrl?: string;
        registry: string;
        json?: boolean;
      }) => {
        let asked: ReturnType<typeof chainFromOptions>;
        try {
          asked = chainFromOptions(options);
        } catch (error) {
          reportError(options.json, 'use --chain', error);
          return;
        }
        let report: StatusReport;
        try {
          const reader = activationReaderFor(asked.chain, asked.rpcUrl ?? '');
          report = await registryStatus(options.registry, reader, asked.chain);
        } catch (error) {
          reportError(options.json, `read the registry at ${options.registry}`, error);
          return;
        }
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else print(report);
        process.exitCode = report.ok
          ? EXIT.ok
          : report.kind === 'registry'
            ? EXIT.findings
            : EXIT.environment;
      },
    );
}
