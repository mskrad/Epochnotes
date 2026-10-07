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
/** One JSON-RPC call. Scans take this function, so tests substitute it without a network. */
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

/** The rent figures of one account type in a scan. */
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

/**
 * A rent scan of a program or a wallet: the rate in force, the schedule, and figures per account type and in
 * total.
 */
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
  /**
   * `exact`: every account was read. `estimate`: a sample, within its standard error.
   * `unreliable`: a sample whose standard error is more than a quarter of the estimate. Do not quote it.
   * `partial`: a sample that leaves accounts out by construction (those too short to hold the sampled byte)
   * and could not read them separately. The figures are a lower bound of the sampled kind, not an estimate of
   * the whole program.
   */
  reliability: 'exact' | 'estimate' | 'unreliable' | 'partial';
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

/** What every scan needs: the endpoint, the gates of the schedule, and the schedule itself. */
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
    notes: [...(known?.note === undefined ? [] : [known.note]), splitNote(known), ...notes],
  };
}

/** More exact-size requests than this are not worth it on a public endpoint; the sample is declared partial instead. */
const MAX_SHORT_SIZE_REQUESTS = 129;

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

/**
 * Values of the sampled byte that are read always, not by chance. A byte that is a flag, a counter, padding or
 * the start of an unset key piles a whole account type onto zero, one or 0xff; when such a group is not drawn,
 * nothing in the groups that were read betrays it. Read in full, they are counted as they are.
 */
const CERTAIN_GROUPS = [0, 1, 255];

/** `count` of the values that are left to chance, in an order fixed by the seed. */
function pick(random: () => number, count: number): number[] {
  const all = Array.from({ length: 256 }, (_, index) => index).filter(
    (value) => !CERTAIN_GROUPS.includes(value),
  );
  for (let index = all.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [all[index], all[other]] = [all[other] as number, all[index] as number];
  }
  return all.slice(0, count);
}

/**
 * A scan by sample: which byte splits accounts into groups, how many groups to read, and the seed that picks
 * them.
 */
export interface SampleOptions extends ScanOptions {
  /** Offset of a byte that is spread evenly over accounts: a byte of a key stored in the data. */
  offset: number;
  /** How many groups to draw from the 253 that are left to chance; three more are always read. */
  buckets: number;
  seed: number;
}

/**
 * For programs too large for one request. Accounts are split into 256 groups by one byte of their data. Three
 * groups are always read (see CERTAIN_GROUPS); of the other 253 a random subset is read in full and its sums
 * are scaled by 253 / subset. The estimate is unbiased however uneven the groups are; its standard error comes
 * from the spread between the sampled groups. Accounts too short to have the byte are in no group: they are
 * asked for by exact size.
 */
export async function sampleProgram(program: string, options: SampleOptions): Promise<RentScanReport> {
  const { rate, slot, steps, notes } = await context(options.rpc, options.gates, options.schedule);
  const known = knownProgram(program);
  const pool = 256 - CERTAIN_GROUPS.length;
  const chosen = pick(mulberry32(options.seed), Math.min(options.buckets, pool));
  const group = (value: number) =>
    result<RpcAccount[]>(options.rpc, 'getProgramAccounts', [
      program,
      // memcmp takes base58; the byte is encoded on its own
      {
        encoding: 'base64',
        dataSlice: SLICE,
        filters: [{ memcmp: { offset: options.offset, bytes: base58OfByte(value) } }],
      },
    ]);

  // Read in full, counted as they are: the certain groups, then the accounts too short to be in any group.
  const exact = classify(known, options.schedule, rate);
  // The types met in the groups that are always read, kept apart: see `piled` below.
  const certain = classify(known, options.schedule, rate);
  for (const value of CERTAIN_GROUPS)
    for (const account of await group(value)) {
      exact.add(account);
      certain.add(account);
    }
  // An account of `offset` bytes or fewer has no byte at the offset. The RPC filters by exact size only; the
  // short sizes are few, so each is asked for.
  const shortSizes = options.offset + 1;
  const covered = shortSizes <= MAX_SHORT_SIZE_REQUESTS;
  let filterIgnored = false;
  if (covered) {
    for (let size = 0; size < shortSizes; size += 1) {
      const accounts = await result<RpcAccount[]>(options.rpc, 'getProgramAccounts', [
        program,
        { encoding: 'base64', dataSlice: SLICE, filters: [{ dataSize: size }] },
      ]);
      // An endpoint that does not know the filter may answer with every account of the program.
      // (an answer without sizes at all is the other failure, and says so itself)
      if (accounts.some((account) => spaceOf(account) !== BigInt(size))) filterIgnored = true;
      else for (const account of accounts) exact.add(account);
    }
  }

  const perGroup: bigint[] = [];
  const perGroupByType = new Map<string, bigint[]>();
  const countsByType = new Map<string, bigint[]>();
  const sampled = classify(known, options.schedule, rate);
  for (const value of chosen) {
    const one = classify(known, options.schedule, rate);
    for (const account of await group(value)) {
      one.add(account);
      sampled.add(account);
    }
    perGroup.push(sum('group', one.buckets()).excessNow);
    for (const bucket of one.buckets()) {
      const series = perGroupByType.get(bucket.type) ?? [];
      series[perGroup.length - 1] = bucket.excessNow;
      perGroupByType.set(bucket.type, series);
      const counts = countsByType.get(bucket.type) ?? [];
      counts[perGroup.length - 1] = BigInt(bucket.accounts);
      countsByType.set(bucket.type, counts);
    }
  }

  const drawn = BigInt(chosen.length);
  const scale = (value: bigint) => (value * BigInt(pool)) / drawn;
  const scaleCount = (value: number) => Math.round((value * pool) / chosen.length);
  const tooWide = (error: bigint, estimate: bigint) => error > 0n && error * 4n > estimate;
  const countErrors = new Map<string, bigint>();
  const buckets = sampled.buckets().map((bucket) => {
    // Groups in which the type did not occur count as zero.
    const series = chosen.map((_, index) => perGroupByType.get(bucket.type)?.[index] ?? 0n);
    const counts = chosen.map((_, index) => countsByType.get(bucket.type)?.[index] ?? 0n);
    const error = standardError(series, pool);
    // A type whose very count is uncertain cannot have a trustworthy sum, even when that sum came out as zero.
    const countError = standardError(counts, pool);
    countErrors.set(bucket.type, countError);
    const rare = tooWide(countError, BigInt(scaleCount(bucket.accounts)));
    return {
      ...bucket,
      accounts: scaleCount(bucket.accounts),
      fundedAtEarlierRate: scaleCount(bucket.fundedAtEarlierRate),
      excessNow: scale(bucket.excessNow),
      aboveMinimumUpperBound: scale(bucket.aboveMinimumUpperBound),
      afterStep: Object.fromEntries(
        Object.entries(bucket.afterStep).map(([step, value]) => [step, scale(value)]),
      ),
      standardError: error,
      unreliable: rare || tooWide(error, scale(bucket.excessNow)),
    };
  });
  // Emptiness is judged on the sampled part alone, before what was read in full is added: an empty sample says
  // nothing about the groups that were not read, however many accounts the exact part holds.
  const sampledTotal = sum('sampled', buckets);
  const error = standardError(perGroup, pool);
  const everyGroupRead = chosen.length === pool;
  const emptySample = sampledTotal.accounts === 0 && !everyGroupRead;

  // A type met in the always-read groups and in none of the drawn ones is piled onto a few values of the byte.
  // Its accounts on those three values were all counted; whether others sit on values that were not drawn, the
  // sample cannot say, and the spread of the drawn groups (all zero for this type) will not show it.
  const piled = new Set(
    everyGroupRead
      ? []
      : certain
          .buckets()
          .map((bucket) => bucket.type)
          .filter((type) => !buckets.some((bucket) => bucket.type === type)),
  );
  for (const part of exact.buckets()) {
    const into = buckets.find((bucket) => bucket.type === part.type);
    if (into === undefined) buckets.push({ ...part, standardError: 0n, unreliable: piled.has(part.type) });
    else {
      into.accounts += part.accounts;
      into.fundedAtEarlierRate += part.fundedAtEarlierRate;
      into.excessNow += part.excessNow;
      into.aboveMinimumUpperBound += part.aboveMinimumUpperBound;
      for (const [step, value] of Object.entries(part.afterStep))
        into.afterStep[step] = (into.afterStep[step] ?? 0n) + value;
      // What was read in full carries no error: the type is judged again on what it now holds.
      into.unreliable =
        tooWide(into.standardError ?? 0n, into.excessNow) ||
        tooWide(countErrors.get(into.type) ?? 0n, BigInt(into.accounts));
    }
  }
  buckets.sort((a, b) => (a.excessNow < b.excessNow ? 1 : -1));
  const total = sum('total', buckets);
  // The width of the error is held against the figure that is reported, the whole total: what was read in full
  // carries no error. And a total is no better than its large parts: an account type that is itself unreliable
  // and makes up a twentieth of the total or more takes the total with it.
  const tooWideTotal = tooWide(error, total.excessNow);
  const shaky = buckets.filter(
    (bucket) => bucket.unreliable && bucket.excessNow * 20n >= total.excessNow && bucket.excessNow > 0n,
  );
  const unreliable = emptySample || tooWideTotal || shaky.length > 0;
  const partial = !covered || filterIgnored;
  const always = CERTAIN_GROUPS.map((value) => `0x${value.toString(16).padStart(2, '0')}`).join(', ');
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
    method: [
      `sample by the byte at offset ${options.offset}, seed ${options.seed}: groups ${always} read always and counted as they are`,
      `${chosen.length} of the other ${pool} groups read and scaled by ${pool}/${chosen.length}`,
      covered && !filterIgnored
        ? `${shortSizes} exact-size request(s) for accounts of ${options.offset} bytes or fewer, counted as they are`
        : `accounts of ${options.offset} bytes or fewer NOT covered`,
    ].join('; '),
    reliability: unreliable ? 'unreliable' : partial ? 'partial' : 'estimate',
    standardError: error,
    buckets,
    total,
    notes: [
      ...(covered
        ? []
        : [
            `PARTIAL: accounts of ${options.offset} bytes or fewer are not covered. They have no byte at the offset and sit in no group, and asking for every size up to ${options.offset} would take more than ${MAX_SHORT_SIZE_REQUESTS} requests. Choose an offset nearer the start of the data, or treat the figures as covering larger accounts only.`,
          ]),
      ...(filterIgnored
        ? [
            'PARTIAL: the endpoint answered a request for accounts of one exact size with accounts of other sizes, so it does not apply the dataSize filter. Nothing from those answers was counted, and accounts too short to hold the sampled byte are not covered. Use another endpoint.',
          ]
        : []),
      ...(unreliable
        ? [
            `UNRELIABLE: ${
              emptySample
                ? 'the sampled groups hold no accounts, which says nothing about the groups that were not read'
                : tooWideTotal
                  ? 'the standard error is more than a quarter of the total'
                  : `the estimate of ${shaky.map((bucket) => bucket.type).join(', ')} is unreliable${shaky.some((bucket) => piled.has(bucket.type)) ? ' (met only in the groups that are always read, so nothing is known about the groups that were not drawn)' : ''}, and that is a twentieth of the total or more`
            }. The byte at offset ${options.offset} is not spread evenly over the accounts that matter: choose another offset or read more groups, and do not quote these figures.`,
          ]
        : []),
      ...(known?.note === undefined ? [] : [known.note]),
      splitNote(known),
      'The standard error belongs to excessNow of the sampled part. The other figures of a sample (accounts, later steps, the upper bound) are scaled the same way and their error is not computed; it can be larger.',
      'A sample can be good for the total and useless for a small account type: each bucket carries its own standard error, and a type that occurs in none of the groups read is missing from the report, not zero. The spread of the groups that were read cannot reveal a group that was not read and holds far more than the others.',
      'The byte must be spread evenly over accounts (a byte of a stored key). A byte of a flag or a counter gives empty groups and a useless estimate: check that the standard error is small next to excessNow.',
      `The requests of a sample are answered at different slots; the slot given is that of the first read.`,
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

/** Standard error of the scaled total, from the spread of the groups read out of a finite pool of groups. */
function standardError(groups: bigint[], pool: number): bigint {
  const count = groups.length;
  if (count < 2) return 0n;
  const values = groups.map(Number);
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1);
  return BigInt(Math.round(pool * Math.sqrt((variance / count) * (1 - count / pool))));
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
      `Who can close a type comes from "close =" constraints in the program sources (${KNOWN_PROGRAMS.map((program) => program.source).join('; ')}), which may be ahead of the deployed programs; closing can have preconditions.`,
      ...notes,
    ],
  };
}

/** Whether the text is a base58 public key; lets a caller refuse a typo before any request is made. */
export const isValidAddress = (text: string): boolean => isAddress(text);
