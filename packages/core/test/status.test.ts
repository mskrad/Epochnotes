import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  type ActivationReader,
  CLUSTER_GENESIS,
  registryStatus,
  SOLANA_CHAINS,
  solanaActivationReader,
  type SolanaReadSource,
  unsupportedReader,
} from '../src/index.js';

const registry = new URL('../../../registry/entries', import.meta.url).pathname;
const devnet = (getAccounts: SolanaReadSource['getAccounts']): SolanaReadSource => ({
  getGenesisHash: async () => CLUSTER_GENESIS.devnet,
  getAccounts,
});
const nothingScheduled = devnet(async (addresses) => ({ slot: 7n, accounts: addresses.map(() => null) }));
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-status-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('registry status', () => {
  it('reports every activation of the four entries, with the chain and the point of the reading', async () => {
    const report = await registryStatus(
      registry,
      solanaActivationReader(nothingScheduled),
      SOLANA_CHAINS.devnet,
    );
    if (!report.ok) throw new Error(JSON.stringify(report));
    expect(report).toMatchObject({ chain: SOLANA_CHAINS.devnet, cluster: 'devnet', point: { slot: '7' } });
    expect([...new Set(report.activations.map((item) => item.entry))]).toEqual([
      'alpenglow',
      'rent-simd-0437',
      'slot-duration',
      'tx-v1',
    ]);
    expect(report.activations).toHaveLength(11);
    expect(report.activations.every((item) => item.status.state === 'absent')).toBe(true);
    expect(report.withoutActivation).toEqual([]);
  });

  it('keeps every state a feature account can be in, in the one shape every chain shares', async () => {
    const tag = (bytes: number[]) => ({
      owner: 'Feature111111111111111111111111111111111111',
      data: new Uint8Array(bytes),
    });
    const states = [
      null,
      tag([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      tag([1, 42, 0, 0, 0, 0, 0, 0, 0]),
      { owner: '11111111111111111111111111111111', data: new Uint8Array(9) },
    ];
    const source = devnet(async (addresses) => ({
      slot: 9n,
      accounts: addresses.map((_, index) => states[index % states.length] ?? null),
    }));
    const report = await registryStatus(registry, solanaActivationReader(source));
    if (!report.ok) throw new Error(JSON.stringify(report));
    expect(report.activations.slice(0, 4).map((item) => item.status)).toEqual([
      { state: 'absent' },
      { state: 'scheduled' },
      { state: 'active', since: { slot: '42' }, confirmedBy: 'feature-account' },
      { state: 'unknown', reason: 'owned by 11111111111111111111111111111111, not by the feature program' },
    ]);
  });

  it('does not ask the network about an invalid registry', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'id: broken\n');
    const never: ActivationReader = {
      identify: () => Promise.reject(new Error('must not be called')),
      read: () => Promise.reject(new Error('must not be called')),
    };
    expect(await registryStatus(dir, never)).toMatchObject({ ok: false, kind: 'registry' });
  });

  it('reports an unreachable chain as a result', async () => {
    const down: SolanaReadSource = {
      getGenesisHash: () => Promise.reject(new Error('fetch failed')),
      getAccounts: () => Promise.reject(new Error('fetch failed')),
    };
    expect(await registryStatus(registry, solanaActivationReader(down), SOLANA_CHAINS.testnet)).toEqual({
      ok: false,
      kind: 'network',
      chain: SOLANA_CHAINS.testnet,
      error: 'fetch failed',
    });
  });

  it('names no chain from an endpoint whose answer about itself is not a genesis hash', async () => {
    for (const answer of [42, null, '', 'not base58 0OIl']) {
      const odd = { ...nothingScheduled, getGenesisHash: async () => answer as unknown as string };
      const report = await registryStatus(registry, solanaActivationReader(odd));
      expect(report, String(answer)).toMatchObject({
        ok: false,
        kind: 'network',
        error: `the endpoint answered getGenesisHash with ${JSON.stringify(answer)}, not a genesis hash`,
      });
    }
  });

  it('refuses an endpoint that serves another chain than the one asked for, rather than answer for it', async () => {
    const report = await registryStatus(
      registry,
      solanaActivationReader(nothingScheduled),
      SOLANA_CHAINS['mainnet-beta'],
    );
    expect(report).toMatchObject({
      ok: false,
      kind: 'network',
      error: `the endpoint serves ${SOLANA_CHAINS.devnet}, not ${SOLANA_CHAINS['mainnet-beta']}`,
    });
  });
});

describe('an entry about another chain', () => {
  const evm = join(dir, 'evm');
  writeFileSync(join(dir, 'placeholder'), '');
  const entry = `schema_version: 2
id: sample-fork
rev: 1
axis: protocol
subject: { standard: eip, name: EIP-0000, title: Sample }
applies:
  activations:
    - { kind: timestamp, chain: 'eip155:1', at: 1, label: sample }
breaks: [{ surface: program, summary: s }]
fix: [{ summary: f }]
sources: [{ kind: proposal, ref: r, retrieved: '2026-10-02' }]
`;

  it('is named on a Solana cluster as having no activation there, not left out', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(evm, { recursive: true });
    writeFileSync(join(evm, 'sample-fork.yaml'), entry);
    const report = await registryStatus(evm, solanaActivationReader(nothingScheduled));
    if (!report.ok) throw new Error(JSON.stringify(report));
    expect(report.activations).toEqual([]);
    expect(report.withoutActivation).toEqual([
      { entry: 'sample-fork', reason: 'no activation on this chain; it activates on eip155:1' },
    ]);
  });

  it('on a chain without an adapter, is unknown with the reason, and the read is not a failure', async () => {
    const report = await registryStatus(evm, unsupportedReader('eip155:1'), 'eip155:1');
    if (!report.ok) throw new Error(JSON.stringify(report));
    expect(report).toMatchObject({ chain: 'eip155:1', point: {} });
    expect(report.activations.map((item) => item.status)).toEqual([
      { state: 'unknown', reason: 'this version of epochnotes has no adapter for eip155:1' },
    ]);
  });
});
