import { createSolanaRpcFromTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
  decodeFeatureAccount,
  type FeatureAccount,
  type FeatureAccountSource,
  featureAccountSourceFromRpc,
  readFeatureStatus,
} from '../src/index.js';

const FEATURE_PROGRAM = 'Feature111111111111111111111111111111111111';
const GATE_A = 'txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL';
const GATE_B = 'A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS';
const GATE_C = 'iBRLjhJnkmDZgNoZRDMW11d8ZV7HvsL3vAyRjZB5npW';

/** A feature account as the chain stores it: bincode Option<u64>. */
function featureAccount(activatedAt?: bigint): FeatureAccount {
  const data = new Uint8Array(9);
  if (activatedAt !== undefined) {
    data[0] = 1;
    new DataView(data.buffer).setBigUint64(1, activatedAt, true);
  }
  return { owner: FEATURE_PROGRAM, data };
}

function sourceOf(accounts: Record<string, FeatureAccount | null>, slot = 500n): FeatureAccountSource {
  return {
    getAccounts: async (addresses) => ({ slot, accounts: addresses.map((item) => accounts[item] ?? null) }),
  };
}

describe('feature gate state', () => {
  it('tells the four outcomes apart: pending, active, absent, cluster unreachable', async () => {
    const source = sourceOf({ [GATE_A]: featureAccount(447_120_000n), [GATE_B]: featureAccount() });
    const report = await readFeatureStatus(source, [GATE_A, GATE_B, GATE_C]);
    expect(report).toMatchObject({ ok: true, slot: 500n });
    if (!report.ok) throw new Error('unreachable');
    expect(report.states.get(GATE_A)).toEqual({ state: 'active', activatedAt: 447_120_000n });
    expect(report.states.get(GATE_B)).toEqual({ state: 'pending' });
    expect(report.states.get(GATE_C)).toEqual({ state: 'absent' });

    const down: FeatureAccountSource = { getAccounts: () => Promise.reject(new Error('fetch failed')) };
    await expect(readFeatureStatus(down, [GATE_A])).resolves.toEqual({ ok: false, error: 'fetch failed' });
  });

  it('keeps slots beyond 2^53 exact', () => {
    const slot = 2n ** 60n + 1n;
    expect(decodeFeatureAccount(featureAccount(slot))).toEqual({ state: 'active', activatedAt: slot });
  });

  it('does not read an account of another program as a feature gate', () => {
    const foreign = { ...featureAccount(1n), owner: '11111111111111111111111111111111' };
    expect(decodeFeatureAccount(foreign)).toMatchObject({ state: 'unreadable' });
    expect(decodeFeatureAccount({ owner: FEATURE_PROGRAM, data: new Uint8Array([1, 0]) })).toMatchObject({
      state: 'unreadable',
    });
    expect(decodeFeatureAccount({ owner: FEATURE_PROGRAM, data: new Uint8Array(10) })).toMatchObject({
      state: 'unreadable',
    });
    expect(
      decodeFeatureAccount({ owner: FEATURE_PROGRAM, data: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0]) }),
    ).toMatchObject({
      state: 'unreadable',
    });
  });

  it('asks for each address once and reports a short answer as a failure', async () => {
    const asked: string[][] = [];
    const counting: FeatureAccountSource = {
      getAccounts: async (addresses) => {
        asked.push(addresses);
        return { slot: 1n, accounts: [] };
      },
    };
    expect(await readFeatureStatus(counting, [GATE_A, GATE_A, GATE_B])).toMatchObject({ ok: false });
    expect(asked).toEqual([[GATE_A, GATE_B]]);
  });

  it('decodes the JSON-RPC answer of getMultipleAccounts through @solana/kit', async () => {
    const requests: unknown[] = [];
    const rpc = createSolanaRpcFromTransport(async ({ payload }) => {
      requests.push(payload);
      // Shape recorded from api.devnet.solana.com on 2026-09-18 (tx-v1 gate active, Alpenglow gate absent).
      return {
        jsonrpc: '2.0',
        id: (payload as { id: string }).id,
        result: {
          context: { apiVersion: '4.3.0', slot: 500335547 },
          value: [
            {
              data: ['AQCmWh0AAAAA', 'base64'],
              executable: false,
              lamports: 867621,
              owner: FEATURE_PROGRAM,
              rentEpoch: 0,
              space: 9,
            },
            null,
          ],
        },
      } as never;
    });
    const report = await readFeatureStatus(featureAccountSourceFromRpc(rpc), [GATE_A, GATE_B]);
    if (!report.ok) throw new Error(report.error);
    expect(report.slot).toBe(500_335_547n);
    expect(report.states.get(GATE_A)).toEqual({ state: 'active', activatedAt: 492_480_000n });
    expect(report.states.get(GATE_B)).toEqual({ state: 'absent' });
    expect(requests).toMatchObject([
      { method: 'getMultipleAccounts', params: [[GATE_A, GATE_B], { encoding: 'base64' }] },
    ]);
  });
});
