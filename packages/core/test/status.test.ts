import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { type FeatureAccountSource, registryStatus } from '../src/index.js';

const registry = new URL('../../../registry/entries', import.meta.url).pathname;
const nothingScheduled: FeatureAccountSource = {
  getAccounts: async (addresses) => ({ slot: 7n, accounts: addresses.map(() => null) }),
};
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-status-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('registry status', () => {
  it('reports every gate of the four entries, with the cluster and the slot of the answer', async () => {
    const report = await registryStatus(registry, 'devnet', nothingScheduled);
    if (!report.ok) throw new Error(JSON.stringify(report));
    expect(report).toMatchObject({ cluster: 'devnet', slot: 7n });
    expect([...new Set(report.gates.map((gate) => gate.entry))]).toEqual([
      'alpenglow',
      'rent-simd-0437',
      'slot-duration',
      'tx-v1',
    ]);
    expect(report.gates).toHaveLength(11);
    expect(report.gates.every((gate) => gate.status.state === 'absent')).toBe(true);
  });

  it('does not ask the network about an invalid registry', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'id: broken\n');
    const never: FeatureAccountSource = {
      getAccounts: () => Promise.reject(new Error('must not be called')),
    };
    expect(await registryStatus(dir, 'devnet', never)).toMatchObject({ ok: false, kind: 'registry' });
  });

  it('reports an unreachable cluster as a result', async () => {
    const down: FeatureAccountSource = { getAccounts: () => Promise.reject(new Error('fetch failed')) };
    expect(await registryStatus(registry, 'testnet', down)).toEqual({
      ok: false,
      kind: 'network',
      cluster: 'testnet',
      error: 'fetch failed',
    });
  });
});
