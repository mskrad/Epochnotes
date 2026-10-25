// Written for the corpus after the shape of the fix that moved into DefiLlama/dimension-adapters (bridges/across.ts,
// getSolanaSlot), which has no licence that allows copying: the slot is searched on block times, and the time of a
// slot is its block time.
import type { Connection } from '@solana/web3.js';

export async function slotAtTime(connection: Connection, timestamp: number): Promise<number> {
  let high = await connection.getSlot('finalized');
  const samples = await connection.getRecentPerformanceSamples(5);
  const seconds = samples.reduce((sum, sample) => sum + sample.samplePeriodSecs, 0);
  const slots = samples.reduce((sum, sample) => sum + sample.numSlots, 0);
  const latestTimestamp = await timeOfSlot(connection, high);
  let low = Math.max(0, high - Math.ceil((latestTimestamp - timestamp) * (slots / seconds) * 2));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await timeOfSlot(connection, middle)) < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

export async function timeOfSlot(connection: Connection, slot: number): Promise<number> {
  for (let candidate = slot; candidate < slot + 64; candidate += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const time = await connection.getBlockTime(candidate).catch(() => null);
    if (time !== null) return time;
  }
  throw new Error(`no block time near slot ${slot}`);
}
