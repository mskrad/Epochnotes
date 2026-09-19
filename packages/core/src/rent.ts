import type { Entry } from './schema.js';

/** Every account pays for 128 bytes of metadata on top of its data. */
export const ACCOUNT_STORAGE_OVERHEAD = 128n;

/** The rates of a staged rent reduction, highest first: the rate before the first step, then one per step. */
export interface RentSchedule {
  entry: string;
  rev: number;
  legacyRate: bigint;
  steps: { rate: bigint; gate: string; label: string }[];
}

/**
 * Reads the schedule out of a registry entry, so that no rate lives in this code. The rate of a step is the
 * number its feature gate is named after in the validator; the rate before the first step is quoted in that
 * step's effect. An entry that does not follow this form does not describe a rent schedule.
 */
export function rentScheduleFromEntry(entry: Entry): RentSchedule {
  const gates = entry.applies.gates ?? [];
  const steps = gates.map((gate) => {
    const rate = /^set_lamports_per_byte_to_(\d+)$/.exec(gate.label)?.[1];
    if (rate === undefined)
      throw new Error(`${entry.id}: gate "${gate.label}" is not named after a lamports_per_byte value`);
    return { rate: BigInt(rate), gate: gate.address, label: gate.label };
  });
  const legacy = /\(from (\d+)\)/.exec(gates[0]?.effect ?? '')?.[1];
  if (legacy === undefined)
    throw new Error(`${entry.id}: the first gate does not say which rate it replaces`);
  const rates = [BigInt(legacy), ...steps.map((step) => step.rate)];
  if (rates.some((rate, index) => index > 0 && rate >= (rates[index - 1] as bigint)))
    throw new Error(`${entry.id}: the rates of the schedule do not go down step by step`);
  return { entry: entry.id, rev: entry.rev, legacyRate: BigInt(legacy), steps };
}

export const minimumBalance = (space: bigint, rate: bigint): bigint =>
  (ACCOUNT_STORAGE_OVERHEAD + space) * rate;

export interface AccountRent {
  /**
   * The earlier rate at which the balance is exactly the minimum: the account holds a rent deposit and nothing
   * else. Undefined when the balance matches no earlier minimum.
   */
  fundedAtRate?: bigint;
  /** Exact: what an account funded at an earlier minimum holds above today's minimum. Zero otherwise. */
  excessNow: bigint;
  /**
   * For an account that matches no earlier minimum: its balance above today's minimum. An upper bound only —
   * such an account may hold reserves, liquidity or fees that are not a rent deposit.
   */
  aboveMinimum: bigint;
  /** Per future rate: the rent part that would sit above that minimum. See `rentAfter`. */
  after: Map<bigint, bigint>;
}

/**
 * The rent part of a balance that sits above the minimum at `rate`. A balance up to the legacy minimum is all
 * rent deposit. A larger balance holds something else too, so only the deposit is counted, assumed to have
 * been made at the legacy rate — an estimate, and the report says so.
 */
export function rentAfter(lamports: bigint, space: bigint, rate: bigint, legacyRate: bigint): bigint {
  const legacyMinimum = minimumBalance(space, legacyRate);
  const atRate = minimumBalance(space, rate);
  if (lamports <= legacyMinimum) return lamports > atRate ? lamports - atRate : 0n;
  return legacyMinimum - atRate;
}

export function accountRent(
  account: { lamports: bigint; space: bigint },
  schedule: RentSchedule,
  currentRate: bigint,
): AccountRent {
  const { lamports, space } = account;
  const earlier = [schedule.legacyRate, ...schedule.steps.map((step) => step.rate)].filter(
    (rate) => rate > currentRate,
  );
  const fundedAtRate = earlier.find((rate) => lamports === minimumBalance(space, rate));
  const above = lamports - minimumBalance(space, currentRate);
  const after = new Map<bigint, bigint>();
  for (const step of schedule.steps)
    if (step.rate < currentRate)
      after.set(step.rate, rentAfter(lamports, space, step.rate, schedule.legacyRate));
  return {
    ...(fundedAtRate === undefined ? {} : { fundedAtRate }),
    excessNow: fundedAtRate === undefined ? 0n : above,
    aboveMinimum: fundedAtRate === undefined && above > 0n ? above : 0n,
    after,
  };
}
