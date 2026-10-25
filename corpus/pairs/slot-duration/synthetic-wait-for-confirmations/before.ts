// Written for the corpus after waits seen in the field: a number of slots is waited out at 400 ms each.
import { DEFAULT_MS_PER_SLOT } from './constants';
import { sleep } from './sleep';

export async function waitForConfirmations(confirmations: number): Promise<void> {
  await sleep(confirmations * DEFAULT_MS_PER_SLOT);
}
