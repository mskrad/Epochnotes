// Written for the corpus: the wait counts slots instead of milliseconds.
import type { Connection } from '@solana/web3.js';
import { sleep } from './sleep';

export async function waitForConfirmations(
  connection: Connection,
  startSlot: number,
  confirmations: number,
): Promise<void> {
  while ((await connection.getSlot('confirmed')) < startSlot + confirmations) await sleep(100);
}
