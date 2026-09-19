import { address, isAddress } from '@solana/addresses';

import { type FeatureAccountSource, type FeatureState, readFeatureStatus } from './feature-status.js';
import { redactUrl } from './onchain.js';
import { accountRent, type RentSchedule } from './rent.js';
import {
  anchorDiscriminator,
  type ClosableBy,
  KNOWN_PROGRAMS,
  type KnownProgram,
  knownProgram,
} from './rent-programs.js';

const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

interface RpcAccount {
  pubkey: string;
  account: { lamports: number; space?: number; data: [string, string] };
}

function spaceOf(account: RpcAccount): bigint {
  // Without the size every minimum would be computed for 128 bytes, silently.
  if (account.account.space === undefined)
    throw new Error(
      'the endpoint does not return the size of accounts (no "space" field); use another endpoint',
    );
  return BigInt(account.account.space);
}
type RpcAnswer = { result?: unknown; error?: { code?: number; message?: string } };
export type RentRpc = (method: string, params: unknown[]) => Promise<RpcAnswer>;

/**
 * Program scans return tens of megabytes, so the timeout is generous. A public endpoint answers 429 when asked
 * too often: the request is repeated after a growing pause, a few times. The endpoint never appears in an error.
 */
export function rentRpc(
  rpcUrl: string,
  { timeoutMs = 300_000, retryDelayMs = 2_000, retries = 4 } = {},
): RentRpc {
  return async (method, params) => {
    try {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 429 && attempt < retries) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
          continue;
        }
        if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
        return (await response.json()) as RpcAnswer;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(`${redactUrl(rpcUrl)} ${text.split(rpcUrl).join('<endpoint>')}`);
    }
  };
}

export interface RentBucket {
  /** Account type by discriminator, `unlisted` for a type the table does not know, `all` when nothing is split. */
  type: string;
  closableBy: ClosableBy | 'unknown';
  closeInstruction?: string;
  accounts: number;
  /** Accounts whose balance is exactly an earlier minimum: a rent deposit and nothing else. */
  fundedAtEarlierRate: number;
  /** Exact, in lamports: what those accounts hold above today's minimum. */
  excessNow: bigint;
  /** Upper bound, in lamports: balance above today's minimum in all other accounts. Not a rent figure. */
  aboveMinimumUpperBound: bigint;
  /** Estimate, in lamports, per future rate: the rent part above that minimum if the step activates. */
  afterStep: Record<string, bigint>;
  /** Sampled scans only: one standard error of this bucket's `excessNow`, and whether it is too large to quote. */
  standardError?: bigint;
  unreliable?: boolean;
}

export interface RentScanReport {
  target: { kind: 'program'; program: string; name?: string } | { kind: 'wallet'; wallet: string };
  endpoint: string;
  slot: string;
  currentRate: bigint;
  schedule: {
    entry: string;
    legacyRate: bigint;
    steps: { rate: bigint; label: string; gate: string; status: FeatureState }[];
  };
  method: string;
  /** `unreliable`: a sample whose standard error is more than a quarter of the estimate. Do not quote it. */
  reliability: 'exact' | 'estimate' | 'unreliable';
  /** One standard error of `excessNow`, in lamports; zero for a full scan. */
  standardError: bigint;
  buckets: RentBucket[];
  total: RentBucket;
  notes: string[];
}

const emptyBucket = (
  type: string,
  closableBy: RentBucket['closableBy'],
  closeInstruction?: string,
): RentBucket => ({
  type,
  closableBy,
  ...(closeInstruction === undefined ? {} : { closeInstruction }),
  accounts: 0,
  fundedAtEarlierRate: 0,
  excessNow: 0n,
  aboveMinimumUpperBound: 0n,
  afterStep: {},
});

function add(
  bucket: RentBucket,
  account: RpcAccount,
  schedule: RentSchedule,
  rate: bigint,
  weight = 1n,
): void {
  const rent = accountRent(
    { lamports: BigInt(account.account.lamports), space: spaceOf(account) },
    schedule,
    rate,
  );
  bucket.accounts += Number(weight);
  if (rent.fundedAtRate !== undefined) bucket.fundedAtEarlierRate += Number(weight);
  bucket.excessNow += rent.excessNow * weight;
  bucket.aboveMinimumUpperBound += rent.aboveMinimum * weight;
  for (const [step, lamports] of rent.after)
    bucket.afterStep[step.toString()] = (bucket.afterStep[step.toString()] ?? 0n) + lamports * weight;
}

function sum(type: string, buckets: RentBucket[]): RentBucket {
  const total = emptyBucket(type, 'unknown');
  for (const bucket of buckets) {
    total.accounts += bucket.accounts;
    total.fundedAtEarlierRate += bucket.fundedAtEarlierRate;
    total.excessNow += bucket.excessNow;
    total.aboveMinimumUpperBound += bucket.aboveMinimumUpperBound;
    for (const [step, lamports] of Object.entries(bucket.afterStep))
      total.afterStep[step] = (total.afterStep[step] ?? 0n) + lamports;
  }
  return total;
}

async function result<T>(rpc: RentRpc, method: string, params: unknown[]): Promise<T> {
  const answer = await rpc(method, params);
  if (answer.error !== undefined)
    throw new Error(`${method} failed: ${answer.error.code ?? ''} ${answer.error.message ?? ''}`.trim());
  return answer.result as T;
}

/** The rate in force, from the Rent sysvar: the first field of the account is lamports_per_byte, u64 LE. */
async function readCurrentRate(rpc: RentRpc): Promise<{ rate: bigint; slot: bigint }> {
  const info = await result<{ context: { slot: number }; value: { data: [string, string] } | null }>(
    rpc,
    'getAccountInfo',
    [RENT_SYSVAR, { encoding: 'base64' }],
  );
  if (info.value === null) throw new Error('the Rent sysvar is missing on this endpoint');
  const data = Buffer.from(info.value.data[0], 'base64');
  if (data.length < 8) throw new Error('the Rent sysvar is shorter than 8 bytes');
  return { rate: data.readBigUInt64LE(0), slot: BigInt(info.context.slot) };
}

async function context(rpc: RentRpc, gates: FeatureAccountSource, schedule: RentSchedule) {
  const { rate, slot } = await readCurrentRate(rpc);
  const status = await readFeatureStatus(
    gates,
    schedule.steps.map((step) => step.gate),
  );
  if (!status.ok) throw new Error(`the cluster did not answer about the feature gates: ${status.error}`);
  const steps = schedule.steps.map((step) => ({
    rate: step.rate,
    label: step.label,
    gate: step.gate,
    status:
      status.states.get(step.gate) ?? ({ state: 'unreadable', reason: 'no state returned' } as FeatureState),
  }));
  const notes: string[] = [];
  const known = [schedule.legacyRate, ...schedule.steps.map((step) => step.rate)];
  if (!known.includes(rate))
    notes.push(
      `The Rent sysvar holds ${rate}, which is not a rate of ${schedule.entry}: the schedule in the registry may be out of date.`,
    );
  const lastActive = [...steps].reverse().find((step) => step.status.state === 'active');
  if (known.includes(rate) && (lastActive?.rate ?? schedule.legacyRate) !== rate)
    notes.push(
      `The Rent sysvar holds ${rate}, but the last active gate sets ${lastActive?.rate ?? schedule.legacyRate}: a gate takes effect at an epoch boundary.`,
    );
  notes.push(
    'Figures for later steps are what would sit above the minimum if that step activates. A gate that is absent is not scheduled; the SIMD makes every later step conditional.',
    `For an account whose balance is above the minimum at the rate of ${schedule.legacyRate}, the later-step figures count a deposit assumed to have been made at that rate; the rest of its balance is not rent. This is an estimate even in a full scan.`,
    'excessNow counts only accounts whose balance is exactly an earlier minimum. aboveMinimumUpperBound may include reserves, liquidity or fees and is not a rent figure.',
    'These are estimates of deposits held above the minimum, not a market size: most of them can be returned only by whoever may close or shrink the account.',
  );
  return { rate, slot, steps, notes };
}

const SLICE = { offset: 0, length: 8 };

function classify(program: KnownProgram | undefined, schedule: RentSchedule, rate: bigint) {
  const byDiscriminator = new Map(
    (program?.types ?? []).map((type) => [anchorDiscriminator(type.name), type] as const),
  );
  const buckets = new Map<string, RentBucket>();
  return {
    add(account: RpcAccount, weight = 1n) {
      const discriminator = Buffer.from(account.account.data[0], 'base64').toString('hex');
      const type = byDiscriminator.get(discriminator);
      const name = program === undefined ? 'all' : (type?.name ?? 'unlisted');
      let bucket = buckets.get(name);
      if (bucket === undefined) {
        bucket = emptyBucket(name, type?.closableBy ?? 'unknown', type?.closeInstruction);
        buckets.set(name, bucket);
      }
      add(bucket, account, schedule, rate, weight);
    },
    buckets: () => [...buckets.values()].sort((a, b) => (a.excessNow < b.excessNow ? 1 : -1)),
  };
}

const splitNote = (program: KnownProgram | undefined): string =>
  program === undefined
    ? 'Account types are not split: this program is not in the table of known programs.'
    : `Account types are told apart by the first 8 bytes of the data (Anchor discriminator). A type is closable when the program source (${program.source}) gives it a "close =" constraint; who signs is read from the ${program.idl.name} ${program.idl.version} IDL fetched from mainnet-beta on ${program.idl.retrieved}. The source may be ahead of the deployed program, and closing can have preconditions.`;

export interface ScanOptions {
  rpc: RentRpc;
  gates: FeatureAccountSource;
  endpoint: string;
  schedule: RentSchedule;
}

/** Every account of a program in one request: lamports, size and the first 8 bytes of data. */
export async function scanProgram(program: string, options: ScanOptions): Promise<RentScanReport> {
  const { rate, slot, steps, notes } = await context(options.rpc, options.gates, options.schedule);
  const known = knownProgram(program);
  const accounts = await result<{ context: { slot: number }; value: RpcAccount[] }>(
    options.rpc,
    'getProgramAccounts',
    [program, { encoding: 'base64', dataSlice: SLICE, withContext: true }],
  );
  const split = classify(known, options.schedule, rate);
  for (const account of accounts.value) split.add(account);
  const buckets = split.buckets();
  return {
    target: { kind: 'program', program, ...(known === undefined ? {} : { name: known.name }) },
    endpoint: redactUrl(options.endpoint),
    slot: BigInt(accounts.context.slot ?? slot).toString(),
    currentRate: rate,
    schedule: {
      entry: `${options.schedule.entry}@${options.schedule.rev}`,
      legacyRate: options.schedule.legacyRate,
      steps,
    },
    method: 'full scan: one getProgramAccounts with an 8-byte data slice; every account counted once',
    reliability: 'exact',
    standardError: 0n,
    buckets,
    total: sum('total', buckets),
    notes: [splitNote(known), ...notes],
  };
}

/** A small deterministic generator, so that a sampled scan can be repeated by anyone with the same seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random: () => number, count: number): number[] {
  const all = Array.from({ length: 256 }, (_, index) => index);
  for (let index = 255; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [all[index], all[other]] = [all[other] as number, all[index] as number];
  }
  return all.slice(0, count);
}

export interface SampleOptions extends ScanOptions {
  /** Offset of a byte that is spread evenly over accounts: a byte of a key stored in the data. */
  offset: number;
  /** How many of the 256 values of that byte to read. */
  buckets: number;
  seed: number;
}

/**
 * For programs too large for one request: accounts are split into 256 groups by one byte of their data, a
 * random subset of groups is read in full, and the sums are scaled by 256 / subset. The estimate is unbiased
 * however uneven the groups are; its standard error comes from the spread between the groups read.
 */
export async function sampleProgram(program: string, options: SampleOptions): Promise<RentScanReport> {
  const { rate, slot, steps, notes } = await context(options.rpc, options.gates, options.schedule);
  const known = knownProgram(program);
  const chosen = pick(mulberry32(options.seed), options.buckets);
  const perGroup: bigint[] = [];
  const perGroupByType = new Map<string, bigint[]>();
  const split = classify(known, options.schedule, rate);
  for (const value of chosen) {
    // memcmp takes base58; one byte padded to a key would not match, so the byte is encoded on its own.
    const bytes = base58OfByte(value);
    const accounts = await result<RpcAccount[]>(options.rpc, 'getProgramAccounts', [
      program,
      { encoding: 'base64', dataSlice: SLICE, filters: [{ memcmp: { offset: options.offset, bytes } }] },
    ]);
    const group = classify(known, options.schedule, rate);
    for (const account of accounts) {
      group.add(account);
      split.add(account);
    }
    perGroup.push(sum('group', group.buckets()).excessNow);
    for (const bucket of group.buckets()) {
      const series = perGroupByType.get(bucket.type) ?? [];
      series[perGroup.length - 1] = bucket.excessNow;
      perGroupByType.set(bucket.type, series);
    }
  }
  const scale = (value: bigint) => (value * 256n) / BigInt(chosen.length);
  const tooWide = (error: bigint, estimate: bigint) => error * 4n > estimate;
  const buckets = split.buckets().map((bucket) => {
    // Groups in which the type did not occur count as zero.
    const series = chosen.map((_, index) => perGroupByType.get(bucket.type)?.[index] ?? 0n);
    const error = standardError(series);
    return {
      ...bucket,
      accounts: Math.round((bucket.accounts * 256) / chosen.length),
      fundedAtEarlierRate: Math.round((bucket.fundedAtEarlierRate * 256) / chosen.length),
      excessNow: scale(bucket.excessNow),
      aboveMinimumUpperBound: scale(bucket.aboveMinimumUpperBound),
      afterStep: Object.fromEntries(
        Object.entries(bucket.afterStep).map(([step, value]) => [step, scale(value)]),
      ),
      standardError: error,
      unreliable: tooWide(error, scale(bucket.excessNow)),
    };
  });
  const total = sum('total', buckets);
  const error = standardError(perGroup);
  const unreliable = tooWide(error, total.excessNow);
  return {
    target: { kind: 'program', program, ...(known === undefined ? {} : { name: known.name }) },
    endpoint: redactUrl(options.endpoint),
    slot: slot.toString(),
    currentRate: rate,
    schedule: {
      entry: `${options.schedule.entry}@${options.schedule.rev}`,
      legacyRate: options.schedule.legacyRate,
      steps,
    },
    method: `sample: ${chosen.length} of 256 groups by the byte at offset ${options.offset}, seed ${options.seed}; sums scaled by 256/${chosen.length}`,
    reliability: unreliable ? 'unreliable' : 'estimate',
    standardError: error,
    buckets,
    total,
    notes: [
      ...(unreliable
        ? [
            `UNRELIABLE: the standard error is more than a quarter of the estimate, so the byte at offset ${options.offset} is not spread evenly over the accounts that matter. Choose another offset or read more groups; do not quote these figures.`,
          ]
        : []),
      splitNote(known),
      'A sample can be good for the total and useless for a small account type: each bucket carries its own standard error, and a type that occurs in none of the groups read is missing from the report, not zero.',
      'The byte must be spread evenly over accounts (a byte of a stored key). A byte of a flag or a counter gives empty groups and a useless estimate: check that the standard error is small next to excessNow.',
      ...notes,
    ],
  };
}

/** Base58 of a single byte: below 58 * 58, so at most two digits; a zero byte is the digit "1". */
function base58OfByte(value: number): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return value < 58
    ? (alphabet[value] as string)
    : `${alphabet[Math.floor(value / 58)]}${alphabet[value % 58]}`;
}

/** Standard error of the scaled total, from the spread of the groups read (finite population of 256). */
function standardError(groups: bigint[]): bigint {
  const count = groups.length;
  if (count < 2) return 0n;
  const values = groups.map(Number);
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1);
  return BigInt(Math.round(256 * Math.sqrt((variance / count) * (1 - count / 256))));
}

/** The accounts of known programs that name this wallet as their owner. */
export async function scanWallet(wallet: string, options: ScanOptions): Promise<RentScanReport> {
  address(wallet); // An invalid address throws here, before any request is made.
  const { rate, slot, steps, notes } = await context(options.rpc, options.gates, options.schedule);
  const buckets: RentBucket[] = [];
  for (const program of KNOWN_PROGRAMS) {
    for (const type of program.types) {
      if (type.ownerOffset === undefined) continue;
      const accounts = await result<RpcAccount[]>(options.rpc, 'getProgramAccounts', [
        program.address,
        {
          encoding: 'base64',
          dataSlice: SLICE,
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: Buffer.from(anchorDiscriminator(type.name), 'hex').toString('base64'),
                encoding: 'base64',
              },
            },
            { memcmp: { offset: type.ownerOffset, bytes: wallet } },
          ],
        },
      ]);
      const bucket = emptyBucket(`${program.name}: ${type.name}`, type.closableBy, type.closeInstruction);
      for (const account of accounts) add(bucket, account, options.schedule, rate);
      if (bucket.accounts > 0) buckets.push(bucket);
    }
  }
  const searched = KNOWN_PROGRAMS.map(
    (program) =>
      `${program.name} (${program.types
        .filter((type) => type.ownerOffset !== undefined)
        .map((type) => type.name)
        .join(', ')})`,
  );
  return {
    target: { kind: 'wallet', wallet },
    endpoint: redactUrl(options.endpoint),
    slot: slot.toString(),
    currentRate: rate,
    schedule: {
      entry: `${options.schedule.entry}@${options.schedule.rev}`,
      legacyRate: options.schedule.legacyRate,
      steps,
    },
    method:
      'wallet scan: getProgramAccounts per account type, filtered by discriminator and by the owner key stored in the data',
    reliability: 'exact',
    standardError: 0n,
    buckets,
    total: sum('total', buckets),
    notes: [
      `Searched: ${searched.join('; ')}. Token accounts and any other program are not covered.`,
      ...notes,
    ],
  };
}

/** Whether the text is a base58 public key; lets a caller refuse a typo before any request is made. */
export const isValidAddress = (text: string): boolean => isAddress(text);
