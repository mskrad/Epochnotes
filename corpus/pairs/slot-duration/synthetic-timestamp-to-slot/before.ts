// Written for the corpus after the shape of getBlockByTimestamp in DefiLlama/bridges-server (src/utils/blocks.ts at
// 19f817b), which has no licence that allows copying: a slot is estimated from a time at 400 ms per slot, and a
// time from a slot the same way.
import type { Connection } from '@solana/web3.js';

export async function slotAtTime(connection: Connection, timestamp: number): Promise<number> {
  const latestSlot = await connection.getSlot('finalized');
  const latestTimestamp = await connection.getBlockTime(latestSlot);
  if (latestTimestamp === null) throw new Error('no block time for the latest slot');
  const estimatedSlot = latestSlot - Math.floor(((latestTimestamp - timestamp) * 1000) / 400);
  const estimatedTimestamp = await connection.getBlockTime(estimatedSlot);
  if (estimatedTimestamp === null) throw new Error('no block time for the estimate');
  return estimatedSlot - Math.floor(((estimatedTimestamp - timestamp) * 1000) / 400);
}

export function timeOfSlot(slot: number, latest: { slot: number; timestamp: number }): number {
  return latest.timestamp - ((latest.slot - slot) * 400) / 1000;
}
