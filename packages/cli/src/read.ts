import {
  CLUSTERS,
  parsePin,
  probeRpc,
  type ReadOptions,
  readRegistry,
  readTrustedPublishers,
  type RegistryReading,
  rpcFeatureAccountSource,
} from '@epochnotes/core';
import { type Command, Option } from 'commander';

import { clusterOf, clusterOption, EXIT, rpcUrlOption } from './cluster.js';
import { reportError, reportIssues } from './output.js';

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
  const chain = from.chain === 'matches' ? 'log matches the chain' : 'chain not checked';
  return `verified: version ${from.version} of ${from.publisher}, root ${from.merkleRoot}, published ${from.published}; ${chain}`;
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
    .option('--onchain', 'also compare the log with the chain and look up revocations')
    .addOption(clusterOption('devnet'))
    .addOption(rpcUrlOption())
    .addOption(
      new Option('--status <cluster>', 'read the activation status of every gate from this cluster').choices(
        Object.keys(CLUSTERS),
      ),
    )
    .option('--status-rpc-url <url>', 'JSON-RPC endpoint for --status instead of the public one')
    .option('--json', 'print the reading as JSON')
    .action(
      async (
        ids: string[],
        options: SourceOptions & {
          onchain?: boolean;
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
            ...(options.status === undefined
              ? {}
              : {
                  status: {
                    cluster: options.status,
                    source: rpcFeatureAccountSource(
                      options.statusRpcUrl ?? CLUSTERS[options.status as keyof typeof CLUSTERS],
                    ),
                  },
                }),
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
            console.log(`status read from ${reading.network.cluster} at slot ${reading.network.slot}`);
          for (const { entry, gates, revokedOnChain } of reading.entries) {
            console.log(`\n${entry.id}@${entry.rev}  ${entry.subject.name}: ${entry.subject.title}`);
            if (revokedOnChain) console.log('  REVOKED on chain by the publisher');
            for (const gate of gates ?? [])
              console.log(
                `  gate ${gate.label}: ${gate.status.state}${gate.status.state === 'active' ? ` since slot ${gate.status.activatedAt}` : ''}`,
              );
            for (const item of entry.breaks) console.log(`  breaks ${item.surface}: ${item.summary}`);
          }
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
    .option('--json', 'print the report as JSON')
    .action(async (options: SourceOptions & { rpcUrl: string }) => {
      try {
        const source = sourceOf(options);
        if (source === undefined) return;
        const reading = await readRegistry(source);
        if (!reading.ok) return reportIssues(options.json, reading.issues);
        const report = await probeRpc(
          options.rpcUrl,
          reading.entries.map(({ entry }) => entry),
        );
        if (options.json) console.log(JSON.stringify({ provenance: reading.provenance, ...report }, null, 2));
        else {
          console.log(provenanceLine(reading));
          console.log(
            `endpoint ${report.endpoint} serves ${report.cluster}; ${report.observed} probe(s) observed its behaviour`,
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
        process.exitCode = report.probes.some((probe) => probe.verdict === 'unreachable')
          ? EXIT.environment
          : report.probes.some((probe) => probe.verdict === 'cannot-read')
            ? EXIT.findings
            : EXIT.ok;
      } catch (error) {
        reportError(options.json, 'probe the endpoint', error);
      }
    });
}
