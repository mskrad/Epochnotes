import { describe, expect, it } from 'vitest';

import {
  accountRent,
  minimumBalance,
  rentAfter,
  type RentSchedule,
  rentScheduleFromEntry,
  validatePath,
  featureGatesOf,
} from '../src/index.js';

const entries = validatePath(new URL('../../../registry/entries', import.meta.url).pathname).files.flatMap(
  (file) => (file.entry === undefined ? [] : [file.entry]),
);
const rentEntry = entries.find((entry) => entry.id === 'rent-simd-0437');
if (rentEntry === undefined) throw new Error('the registry has no rent entry');

// A made-up schedule, so that the formulas are tested on numbers a reader can check by hand.
const schedule: RentSchedule = {
  entry: 'test',
  rev: 1,
  legacyRate: 1000n,
  steps: [
    { rate: 800n, gate: 'a', label: 'a' },
    { rate: 500n, gate: 'b', label: 'b' },
    { rate: 100n, gate: 'c', label: 'c' },
  ],
};

describe('the rent schedule of the registry entry', () => {
  it('is read from the gates: the rate before the first step, then one falling rate per gate', () => {
    const read = rentScheduleFromEntry(rentEntry);
    expect(read.legacyRate).toBe(6960n);
    expect(read.steps.map((step) => step.rate)).toEqual([6333n, 5080n, 2575n, 1322n, 696n]);
    expect(read.steps.map((step) => step.gate)).toEqual(
      featureGatesOf(rentEntry).map((gate) => gate.address),
    );
  });

  it('refuses an entry whose gates are not rent steps', () => {
    const other = entries.find((entry) => entry.id === 'tx-v1');
    if (other === undefined) throw new Error('no tx-v1 entry');
    expect(() => rentScheduleFromEntry(other)).toThrow('is not named after a lamports_per_byte value');
  });

  it('refuses a schedule whose rates do not fall', () => {
    const activations = [...featureGatesOf(rentEntry)].reverse();
    activations[0] = { ...(activations[0] as (typeof activations)[0]), effect: 'Step. (from 6960)' };
    if (rentEntry.schema_version !== 2) throw new Error('the rent entry is expected in schema 2');
    expect(() => rentScheduleFromEntry({ ...rentEntry, applies: { activations } })).toThrow('do not go down');
  });
});

describe('rent formulas', () => {
  it('computes the minimum as (128 + size) * rate, also for an account of size zero', () => {
    expect(minimumBalance(0n, 1000n)).toBe(128_000n);
    expect(minimumBalance(72n, 500n)).toBe(100_000n);
  });

  it('an account funded at the legacy minimum holds exactly the difference of the rates', () => {
    const rent = accountRent({ lamports: 200_000n, space: 72n }, schedule, 500n);
    expect(rent.fundedAtRate).toBe(1000n);
    expect(rent.excessNow).toBe(100_000n);
    expect(rent.aboveMinimum).toBe(0n);
    expect([...rent.after]).toEqual([[100n, 180_000n]]);
  });

  it('an account funded at an intermediate step counts too', () => {
    const rent = accountRent({ lamports: 160_000n, space: 72n }, schedule, 500n);
    expect(rent.fundedAtRate).toBe(800n);
    expect(rent.excessNow).toBe(60_000n);
  });

  it('an account of size zero at the legacy minimum', () => {
    const rent = accountRent({ lamports: 128_000n, space: 0n }, schedule, 500n);
    expect(rent.excessNow).toBe(64_000n);
    expect(rent.after.get(100n)).toBe(115_200n);
  });

  it('a balance above the legacy minimum is not called excess: only its rent part is projected', () => {
    // 200 000 of deposit at the legacy rate plus 5 000 000 of something else.
    const rent = accountRent({ lamports: 5_200_000n, space: 72n }, schedule, 500n);
    expect(rent.fundedAtRate).toBeUndefined();
    expect(rent.excessNow).toBe(0n);
    expect(rent.aboveMinimum).toBe(5_100_000n);
    expect(rent.after.get(100n)).toBe(180_000n);
    expect(rentAfter(5_200_000n, 72n, 100n, 1000n)).toBe(180_000n);
  });

  it('an account at the current minimum has no excess now and the full step difference later', () => {
    const rent = accountRent({ lamports: 100_000n, space: 72n }, schedule, 500n);
    expect(rent).toMatchObject({ excessNow: 0n, aboveMinimum: 0n });
    expect(rent.after.get(100n)).toBe(80_000n);
  });

  it('an account below the current minimum is never negative', () => {
    const rent = accountRent({ lamports: 10n, space: 72n }, schedule, 500n);
    expect(rent).toMatchObject({ excessNow: 0n, aboveMinimum: 0n });
    expect(rent.after.get(100n)).toBe(0n);
  });

  it('projects nothing for steps that are already in force', () => {
    const rent = accountRent({ lamports: 200_000n, space: 72n }, schedule, 100n);
    expect([...rent.after]).toEqual([]);
    expect(rent.excessNow).toBe(180_000n);
  });
});
