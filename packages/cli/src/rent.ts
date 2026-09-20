import {
  isValidAddress,
  planClose,
  readRegistry,
  type RentBucket,
  rentRpc,
  type RentScanReport,
  rentScheduleFromEntry,
  rpcFeatureAccountSource,
  sampleProgram,
  scanProgram,
  scanWallet,
  simulateClose,
  withdrawExcessTemplate,
} from '@epochnotes/core';
import { Command } from 'commander';

import {
  clusterOption,
  EXIT,
  registryClusterOf,
  registryClusterOption,
  registryRpcUrlOption,
  rpcUrlOf,
  rpcUrlOption,
} from './cluster.js';
import { reportError, reportIssues } from './output.js';
import {
  type ChainOptions,
  printRevoked,
  provenanceLine,
  sourceOf,
  type SourceOptions,
  withSource,
} from './read.js';

/** Lamports as SOL, rounded to three decimals. */
const sol = (lamports: bigint): string => {
  const thousandths = (lamports + 500_000n) / 1_000_000n;
  return `${thousandths / 1000n}.${(thousandths % 1000n).toString().padStart(3, '0')} SOL`;
};

function line(bucket: RentBucket): string {
  const later = Object.entries(bucket.afterStep)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([rate, lamports]) => `at ${rate}: ${sol(lamports)}`)
    .join(', ');
  const who =
    bucket.type === 'total'
      ? ''
      : `  [closable by ${bucket.closableBy}${bucket.closeInstruction === undefined ? '' : `: ${bucket.closeInstruction}`}]`;
  return [
    `${bucket.type}${who}`,
    `    accounts ${bucket.accounts}, at an earlier minimum ${bucket.fundedAtEarlierRate}`,
    `    excess now ${sol(bucket.excessNow)}${bucket.standardError === undefined ? '' : ` ±${sol(bucket.standardError)}${bucket.unreliable ? ' UNRELIABLE' : ''}`}; other balance above the minimum (upper bound, not rent) ${sol(bucket.aboveMinimumUpperBound)}`,
    `    if later steps activate — ${later === '' ? 'none left' : later}`,
  ].join('\n');
}

function print(report: RentScanReport): void {
  const target =
    report.target.kind === 'program'
      ? `program ${report.target.program}${report.target.name === undefined ? '' : ` (${report.target.name})`}`
      : `wallet ${report.target.wallet}`;
  console.log(`${target} on ${report.endpoint}, slot ${report.slot}`);
  console.log(
    `rate now ${report.currentRate} lamports per byte (Rent sysvar); schedule ${report.schedule.entry}, from ${report.schedule.legacyRate}`,
  );
  for (const step of report.schedule.steps) console.log(`  ${step.label}: ${step.status.state}`);
  console.log(`method: ${report.method}`);
  console.log(
    `reliability: ${report.reliability}${report.reliability !== 'exact' ? `, one standard error of excess now ${sol(report.standardError)}` : ''}\n`,
  );
  for (const bucket of report.buckets) console.log(line(bucket));
  if (report.buckets.length === 0) console.log('no accounts found');
  console.log(`\n${line(report.total)}\n`);
  for (const note of report.notes) console.log(`note: ${note}`);
}

interface ScanCommandOptions extends SourceOptions, ChainOptions {
  program?: string;
  wallet?: string;
  entry: string;
  sample?: boolean;
  offset: string;
  groups: string;
  seed: string;
  cluster: string;
  rpcUrl?: string;
}

export function rentCommand(): Command {
  const rent = new Command('rent').description(
    'Rent deposits left above the minimum by the staged rent reduction.',
  );
  withSource(
    rent
      .command('scan')
      .description(
        'Measure, read-only, what the accounts of a program or of a wallet hold above the rent minimum, now and at each later step.',
      )
      .option('--program <address>', 'scan every account of this program')
      .option('--wallet <address>', 'scan the accounts of known programs that this wallet owns')
      .option('--entry <id>', 'registry entry that carries the rent schedule', 'rent-simd-0437')
      .option('--sample', 'estimate a program too large for one request from a random subset of its accounts')
      .option(
        '--offset <n>',
        'with --sample: offset of an evenly spread byte, such as a byte of a stored key',
        '8',
      )
      .option(
        '--groups <n>',
        'with --sample: how many groups to draw from the 253 left to chance (three more are always read)',
        '12',
      )
      .option(
        '--seed <n>',
        'with --sample: seed of the random choice, so the run can be repeated',
        '20260918',
      ),
  )
    .option('--onchain', 'also compare the log with the chain and refuse a schedule entry revoked there')
    .addOption(registryClusterOption())
    .addOption(registryRpcUrlOption())
    .addOption(clusterOption('mainnet-beta'))
    .addOption(rpcUrlOption())
    .option('--json', 'print the report as JSON')
    .action(async (options: ScanCommandOptions, command: Command) => {
      if ((options.program === undefined) === (options.wallet === undefined)) {
        reportError(options.json, 'scan', new Error('pass exactly one of --program and --wallet'));
        return;
      }
      if (options.sample && options.program === undefined) {
        reportError(options.json, 'scan', new Error('--sample works with --program only'));
        return;
      }
      const given = ['offset', 'groups', 'seed'].filter(
        (name) => command.getOptionValueSource(name) === 'cli',
      );
      if (!options.sample && given.length > 0) {
        reportError(options.json, 'scan', new Error(`--${given[0]} has a meaning with --sample only`));
        return;
      }
      const texts = [options.offset, options.groups, options.seed];
      const [offset, groups, seed] = texts.map(Number) as [number, number, number];
      if (texts.some((text) => !/^\d+$/.test(text)) || groups < 2 || groups > 256) {
        reportError(
          options.json,
          'scan',
          new Error('--offset and --seed must be whole numbers, --groups between 2 and 256'),
        );
        return;
      }
      if (!isValidAddress(options.program ?? options.wallet ?? '')) {
        reportError(options.json, 'scan', new Error('the address is not a valid base58 public key'));
        return;
      }
      try {
        const source = sourceOf(options);
        if (source === undefined) return;
        const reading = await readRegistry({
          ...source,
          ids: [options.entry],
          ...(options.onchain ? { onchain: registryClusterOf(options) } : {}),
        });
        if (!reading.ok) return reportIssues(options.json, reading.issues);
        const entry = reading.entries[0]?.entry;
        if (entry === undefined) {
          reportError(options.json, 'scan', new Error(`the registry has no entry "${options.entry}"`));
          return;
        }
        const rpcUrl = rpcUrlOf(options);
        const scan = {
          rpc: rentRpc(rpcUrl),
          gates: rpcFeatureAccountSource(rpcUrl),
          endpoint: rpcUrl,
          schedule: rentScheduleFromEntry(entry),
        };
        const report =
          options.wallet !== undefined
            ? await scanWallet(options.wallet, scan)
            : options.sample
              ? await sampleProgram(options.program as string, { ...scan, offset, buckets: groups, seed })
              : await scanProgram(options.program as string, scan);
        if (options.json)
          console.log(
            JSON.stringify(
              { provenance: reading.provenance, revoked: reading.revoked, ...report },
              (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
              2,
            ),
          );
        else {
          console.log(provenanceLine(reading));
          printRevoked(reading);
          print(report);
        }
        process.exitCode = EXIT.ok;
      } catch (error) {
        reportError(options.json, 'scan', error);
      }
    });
  rent
    .command('close')
    .description(
      'Build, without signing, the transaction that returns the rent deposit of one account to its owner, and ask the cluster what it would do. Nothing is sent.',
    )
    .requiredOption('--account <address>', 'the account to close, or to reclaim the excess from')
    // With both forms declared the default has to be spelled out, or neither flag means "do not simulate".
    .option('--simulate', 'ask the cluster what the transaction would do (the default)', true)
    .option('--no-simulate', 'only build the transaction')
    .addOption(clusterOption('mainnet-beta'))
    .addOption(rpcUrlOption())
    .option('--json', 'print the plan and the simulation as JSON')
    .action(
      async (options: {
        account: string;
        simulate: boolean;
        cluster: string;
        rpcUrl?: string;
        json?: boolean;
      }) => {
        if (!isValidAddress(options.account)) {
          reportError(
            options.json,
            'plan the close',
            new Error('the address is not a valid base58 public key'),
          );
          return;
        }
        try {
          const rpcUrl = rpcUrlOf(options);
          const plan = await planClose(rpcUrl, options.account);
          if (!plan.ok) {
            reportIssues(options.json, [
              {
                path: options.account,
                message: plan.reason,
                hint: 'Run `epochnotes rent scan` to see which account types can be closed, and by whom.',
              },
            ]);
            return;
          }
          const simulation = options.simulate ? await simulateClose(rpcUrl, plan) : undefined;
          if (options.json)
            console.log(
              JSON.stringify(
                // One `ok` for the whole answer: a caller that reads only it must not see a failed simulation as success.
                { ...plan, ok: simulation?.ok ?? true, ...(simulation === undefined ? {} : { simulation }) },
                (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
                2,
              ),
            );
          else {
            console.log(
              `${plan.program.name} ${plan.type} ${plan.account}: ${plan.lamports} lamports, ${plan.space} bytes`,
            );
            console.log(
              `${plan.action} with ${plan.instruction}; signer and destination: the owner ${plan.owner}`,
            );
            for (const condition of plan.preconditions) console.log(`  the program requires: ${condition}`);
            if (simulation !== undefined) {
              console.log(
                simulation.ok
                  ? `simulation on ${simulation.endpoint} at slot ${simulation.slot}: would succeed, the owner would receive ${simulation.returned} lamports net of the fee`
                  : simulation.notSimulated === undefined
                    ? `simulation on ${simulation.endpoint} at slot ${simulation.slot}: would FAIL — ${simulation.error}`
                    : `simulation on ${simulation.endpoint} at slot ${simulation.slot}: NOT RUN — ${simulation.error}. ${simulation.notSimulated}`,
              );
              for (const entry of simulation.logs) console.log(`  ${entry}`);
            }
            // A transaction the program would refuse is not offered for signing.
            if (simulation === undefined || simulation.ok || simulation.notSimulated !== undefined)
              console.log(
                `\nunsigned transaction (base64; sign it in the owner's wallet — this tool holds no keys and sends nothing):\n${plan.transaction}`,
              );
          }
          // Refused by the program: a finding. Not run at all: the environment could not answer.
          process.exitCode =
            simulation === undefined || simulation.ok
              ? EXIT.ok
              : simulation.notSimulated === undefined
                ? EXIT.findings
                : EXIT.environment;
        } catch (error) {
          reportError(options.json, 'plan the close', error);
        }
      },
    );
  rent
    .command('template')
    .description(
      'Print an Anchor instruction, withdraw_excess, that lets the authority of a program-owned account take out what it holds above the rent-exempt minimum.',
    )
    .option('--account-type <Name>', 'the account type of your program', 'Vault')
    .option('--authority-field <name>', 'the field of that type which holds the authority', 'authority')
    .action((options: { accountType: string; authorityField: string }) => {
      try {
        process.stdout.write(withdrawExcessTemplate(options));
      } catch (error) {
        reportError(false, 'fill the template', error);
      }
    });
  return rent;
}
