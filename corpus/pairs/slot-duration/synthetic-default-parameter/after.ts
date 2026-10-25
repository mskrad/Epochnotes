// Written for the corpus: the age comes from the block times of both slots.
import type { Connection } from '@solana/web3.js';

export async function formatAge(connection: Connection, slot: number, currentSlot: number): Promise<string> {
  const [then, now] = await Promise.all([connection.getBlockTime(slot), connection.getBlockTime(currentSlot)]);
  if (then === null || now === null) return 'unknown';
  return `${now - then}s ago`;
}
