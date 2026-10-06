import {
  type ActivationReader,
  activationReaderFor,
  parsePin,
  probeRpc,
  type ReadOptions,
  readRegistry,
  readTrustedPublishers,
  type RegistryReading,
  subjectOf,
} from '@epochnotes/core';
import { type Command, Option } from 'commander';

import {
  chainOption,
  clusterOf,
  clusterOption,
  EXIT,
  registryClusterOf,
  registryClusterOption,
  registryRpcUrlOption,
  resolveChain,
  rpcUrlOption,
} from './cluster.js';
import { reportError, reportIssues } from './output.js';
import { describeActivation, readingLine } from './status.js';

/** Options of commands that can ask the registry program, and keep `--cluster` / `--rpc-url` for something else. */
export interface ChainOptions {
  onchain?: boolean;
  registryCluster: string;
  registryRpcUrl?: string;
}

export interface SourceOptions {
  versions: string;
  publishers: string;
  mirror?: string[];
  pin?: string;
  workingCopy?: string;
  json?: boolean;
}

/** The options that say where entries come from: the signed log by default, unsigned files only when asked. */
export function withSource(command: Command): Command {
  return command
    .addOption(
      new Option(
        '--versions <dir-or-url>',
        'directory of the version log, or the base URL of a host that serves it',
      )
        .default('registry/versions')
        .env('EPOCHNOTES_VERSIONS'),
    )
    .addOption(
      new Option('--publishers <file>', 'trusted publishers')
        .default('registry/publishers.json')
        .env('EPOCHNOTES_PUBLISHERS'),
    )
    .option('--mirror <url...>', 'hash-addressed mirrors tried after the manifest uri')
    .option('--pin <n:root>', 'the version seen last time; detects a rolled-back or rewritten log')
    .option(
      '--working-copy <dir>',
      'read unsigned entry files instead of the signed log; the output says they are unverified',
    );
}

export function sourceOf(options: SourceOptions): Pick<ReadOptions, 'log' | 'workingCopy'> | undefined {
  if (options.workingCopy !== undefined) return { workingCopy: options.workingCopy };
  const pin = options.pin === undefined ? undefined : parsePin(options.pin);
  if (options.pin !== undefined && pin === undefined) {
    reportError(
      options.json,
      'read --pin',
      new Error('it must look like 3:<64 hex characters>, as printed by a previous verify'),
    );
    return undefined;
  }
  return {
    log: {
      versionsDir: options.versions,
      trustedPublishers: readTrustedPublishers(options.publishers),
      ...(options.mirror === undefined ? {} : { mirrors: options.mirror }),
      ...(pin === undefined ? {} : { pin }),
    },
  };
}

export function provenanceLine(reading: Extract<RegistryReading, { ok: true }>): string {
  const from = reading.provenance;
  if (!from.verified) return `UNVERIFIED working copy ${from.workingCopy}: ${from.warning}`;
  const chain =
    from.chain === 'matches'
      ? 'log matches the chain, revocations checked'
      : 'chain and revocations not checked (pass --onchain): a withdrawn entry may be among these';
  return `verified: version ${from.version} of ${from.publisher}, root ${from.merkleRoot}, published ${from.published}; ${chain}`;
}

/** Entries the publisher withdrew on chain: named, never shown. */
export function printRevoked(reading: Extract<RegistryReading, { ok: true }>): void {
  for (const record of reading.revoked) {
    const shown = reading.entries.some(({ entry }) => entry.id === record.id);
    console.log(
      `${record.id}: REVOKED on chain by its publisher (at version ${record.atVersion}); ${shown ? 'shown above because you asked to include it' : 'not used'}. Revocation account ${record.address}`,
    );
  }
}

/** The reader `--status` asks: the chain resolved from what the user typed, at its endpoint. */
function statusOf(name: string, rpcUrl?: string): { reader: ActivationReader; chain?: string } {
  const asked = resolveChain(name, rpcUrl);
  return {
    reader: activationReaderFor(asked.chain, asked.rpcUrl ?? ''),
    ...(asked.chain === undefined ? {} : { chain: asked.chain }),
  };
}

export function addReadCommand(registry: Command): void {
  withSource(
    registry
      .command('read')
      .description(
        'Print entries from the latest verified version, with where they came from and, if asked, what the network says about their gates.',
      )
      .argument('[entry-id...]', 'ids to print; all entries when omitted'),
  )
    .option('--onchain', 'also compare the log with the chain and leave out entries revoked there')
    .option('--include-revoked', 'with --onchain: print revoked entries too, marked; for diagnostics only')
    .addOption(clusterOption('devnet'))
    .addOption(rpcUrlOption())
    .addOption(chainOption('--status <chain>', 'read the state of every activation on this chain'))
    .option('--status-rpc-url <url>', 'JSON-RPC endpoint for --status instead of the public one')
    .option('--json', 'print the reading as JSON')
    .action(
      async (
        ids: string[],
        options: SourceOptions & {
          onchain?: boolean;
          includeRevoked?: boolean;
          cluster: string;
          rpcUrl?: string;
          status?: string;
          statusRpcUrl?: string;
        },
      ) => {
        let reading: RegistryReading;
        try {
          const source = sourceOf(options);
          if (source === undefined) return;
          reading = await readRegistry({
            ...source,
            ids,
            ...(options.onchain ? { onchain: clusterOf(options) } : {}),
            ...(options.includeRevoked ? { includeRevoked: true } : {}),
            ...(options.status === undefined
              ? {}
              : { status: statusOf(options.status, options.statusRpcUrl) }),
          });
        } catch (error) {
          reportError(options.json, 'read the registry', error);
          return;
        }
        if (!reading.ok) return reportIssues(options.json, reading.issues);
        if (options.json) {
          // Slots are 64-bit: printed as decimal strings so no JSON reader rounds them.
          console.log(
            JSON.stringify(
              reading,
              (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
              2,
            ),
          );
        } else {
          console.log(provenanceLine(reading));
          if (reading.network !== undefined)
            console.log(
              `status: ${readingLine(
                reading.network,
                reading.entries.some((item) => (item.activations ?? []).length > 0),
              )}`,
            );
          for (const { entry, activations, noActivation, revokedOnChain } of reading.entries) {
            const subject = subjectOf(entry);
            console.log(`\n${entry.id}@${entry.rev}  ${subject.name}: ${subject.title}`);
            if (revokedOnChain) console.log('  REVOKED on chain by its publisher: do not rely on this entry');
            for (const item of activations ?? [])
              console.log(`  ${item.activation.label}: ${describeActivation(item.status)}`);
            if (noActivation !== undefined) console.log(`  ${noActivation}`);
            for (const item of entry.breaks) console.log(`  breaks ${item.surface}: ${item.summary}`);
            for (const item of entry.fix) console.log(`  fix: ${item.summary}`);
            entry.sources.forEach((source, index) =>
              console.log(
                `  source [${index}] ${source.kind}: ${source.ref} (retrieved ${source.retrieved})`,
              ),
            );
          }
          if (reading.revoked.length > 0) console.log('');
          printRevoked(reading);
          for (const id of reading.unknownIds) console.log(`\n${id}: no such entry in this version`);
        }
        process.exitCode = reading.unknownIds.length > 0 ? EXIT.findings : EXIT.ok;
      },
    );
}

export function addRpcCheckCommand(check: Command): void {
  withSource(
    check
      .command('rpc')
      .description(
        'Ask one RPC endpoint, read-only, whether it behaves the way the registry entries say. Providers differ.',
      )
      .requiredOption('--rpc-url <url>', 'the JSON-RPC endpoint to probe'),
  )
    .option('--onchain', 'also compare the log with the chain and leave out entries revoked there')
    .addOption(registryClusterOption())
    .addOption(registryRpcUrlOption())
    .option('--json', 'print the report as JSON')
    .action(async (options: SourceOptions & ChainOptions & { rpcUrl: string }) => {
      try {
        const source = sourceOf(options);
        if (source === undefined) return;
        const reading = await readRegistry({
          ...source,
          ...(options.onchain ? { onchain: registryClusterOf(options) } : {}),
        });
        if (!reading.ok) return reportIssues(options.json, reading.issues);
        const report = await probeRpc(
          options.rpcUrl,
          reading.entries.map(({ entry }) => entry),
        );
        if (options.json)
          console.log(
            JSON.stringify({ provenance: reading.provenance, revoked: reading.revoked, ...report }, null, 2),
          );
        else {
          console.log(provenanceLine(reading));
          printRevoked(reading);
          console.log(
            `endpoint ${report.endpoint} serves ${report.cluster}; ${report.observed} probe(s) observed its behaviour`,
          );
          if (report.observed === 0)
            console.log(
              report.probes.length === 0
                ? 'nothing was learned about this endpoint: no entry of this version carries a probe to run, so nothing was asked of it'
                : 'nothing was learned about this endpoint: do not read this run as a clean bill of health',
            );
          for (const probe of report.probes) {
            console.log(
              `\n${probe.verdict}  ${probe.entry} ${probe.rule}\n  expects: ${probe.expect}\n  ${probe.explanation}`,
            );
            for (const call of probe.calls)
              console.log(
                `  maxSupportedTransactionVersion ${call.parameter}: ${call.outcome.ok ? `version ${call.outcome.version}` : `error ${call.outcome.code ?? '-'} ${call.outcome.message}`}`,
              );
          }
        }
        // A run that observed nothing is an environment that could not answer the question, not a pass:
        // exit 0 here would let a devnet endpoint, for which no entry has a fixture, keep a check green.
        process.exitCode = report.probes.some((probe) => probe.verdict === 'unreachable')
          ? EXIT.environment
          : report.probes.some((probe) => probe.verdict === 'cannot-read')
            ? EXIT.findings
            : report.observed === 0
              ? EXIT.environment
              : EXIT.ok;
      } catch (error) {
        reportError(options.json, 'probe the endpoint', error);
      }
    });
}
