import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type DeclaredFeature,
  draftEntry,
  type Entry,
  type FeatureAccountSource,
  parseAgaveFeatures,
  validateEntryYaml,
  validatePath,
  watchReportMarkdown,
  watchSolana,
} from '../src/index.js';

const excerpt = readFileSync(new URL('./fixtures/agave/feature-set-excerpt.rs', import.meta.url), 'utf8');
const entries = validatePath(new URL('../../../registry/entries', import.meta.url).pathname).files.flatMap(
  (file) => (file.entry === undefined ? [] : [file.entry]),
);
const AGAVE = {
  repository: 'https://github.com/anza-xyz/agave',
  commit: 'a'.repeat(40),
  retrieved: '2026-10-07',
};

const ALPENGLOW = 'A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS';
const SLOT_200MS = 'iBRLjhJnkmDZgNoZRDMW11d8ZV7HvsL3vAyRjZB5npW';
const VOTE_STATE_V4 = 'Gx4XFcrVMt4HUvPzTpTSVkdDVgcDSjKhDN1RqRS6KDuZ';
const STAKE_V5 = 'STk5Xj8hdAx3sTzmtJ3QysKkq6X2A3yj73JtxttiRyk';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

type Account = 'active' | 'pending' | 'lamports';
/** A fake cluster: the accounts that exist on it, by address. Every other address has no account. */
function cluster(accounts: Record<string, Account>, slot = 100n): FeatureAccountSource & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    async getAccounts(addresses) {
      asked.push(addresses.length);
      return {
        slot,
        accounts: addresses.map((address) => {
          const kind = accounts[address];
          if (kind === undefined) return null;
          if (kind === 'lamports')
            return { owner: '11111111111111111111111111111111', data: new Uint8Array() };
          const data = new Uint8Array(9);
          if (kind === 'active') data.set([1, 42]);
          return { owner: 'Feature111111111111111111111111111111111111', data };
        }),
      };
    },
  };
}

const watch = (
  clusters: Record<'mainnet-beta' | 'testnet' | 'devnet', FeatureAccountSource>,
  previous?: Awaited<ReturnType<typeof watchSolana>>['snapshot'],
  agaveSource = excerpt,
) =>
  watchSolana({
    agaveSource,
    agave: AGAVE,
    clusters,
    entries,
    ...(previous === undefined ? {} : { previous }),
  });

describe('reading the gates agave declares', () => {
  it('finds every gate FEATURE_NAMES registers in a real excerpt, nested modules included', () => {
    const features = parseAgaveFeatures(excerpt);
    expect(features.map((feature) => feature.module)).toEqual([
      'full_inflation::devnet_and_testnet',
      'full_inflation::mainnet::certusone::vote',
      'full_inflation::mainnet::certusone::enable',
      'secp256k1_program_enabled',
      'credits_auto_rewind',
      'alpenglow',
      'vote_state_v4',
      'upgrade_bpf_stake_program_to_v5',
      'reduce_slot_time_to_200ms',
    ]);
    // Program buffers are declared inside feature modules but are not gates.
    expect(features.map((feature) => feature.address)).not.toContain(
      'BM11F4hqrpinQs28sEZfzQ2fYddivYs4NEAHF6QMjkJF',
    );
    expect(features.map((feature) => feature.address)).not.toContain(
      '4EBQBjw1kqF1dqUBb6fc5Ji4tCEQgNf9ESGGX3smwXwh',
    );
  });

  it('reads names on one line or two, a string over two lines, and the SIMD a name gives', () => {
    const byModule = new Map(parseAgaveFeatures(excerpt).map((feature) => [feature.module, feature]));
    expect(byModule.get('vote_state_v4')).toEqual({
      module: 'vote_state_v4',
      address: VOTE_STATE_V4,
      description: 'SIMD-0185: Vote State v4',
      simd: 'SIMD-0185',
    });
    expect(byModule.get('credits_auto_rewind')?.description).toBe(
      "Auto rewind stake's credits_observed if (accidental) vote recreation is detected #22546",
    );
    expect(byModule.get('credits_auto_rewind')?.simd).toBeUndefined();
    expect(byModule.get('full_inflation::mainnet::certusone::vote')?.description).toBe(
      'community vote allowing Certus One to enable full inflation',
    );
  });

  it('lets no later line rename a gate, and finds nothing in what is not the file', () => {
    const renamed = `${excerpt}\nfn later() { let x = (alpenglow::id(), "something else"); }\n`;
    expect(parseAgaveFeatures(renamed).find((feature) => feature.module === 'alpenglow')?.description).toBe(
      'SIMD-0326: Alpenglow: new consensus algorithm',
    );
    expect(parseAgaveFeatures('<html><body>404: Not Found</body></html>')).toEqual([]);
    expect(parseAgaveFeatures('')).toEqual([]);
  });

  it('stays linear on hostile input', () => {
    const hostile = [
      `${'pub mod a {\n'.repeat(20_000)}`,
      `${' '.repeat(100_000)}pub mod`,
      `x${'::x'.repeat(50_000)}::id(),${' '.repeat(50_000)}`,
      `    "${'\\'.repeat(100_000)}`,
      `${'declare_id!("'.repeat(20_000)}`,
    ].join('\n');
    const started = performance.now();
    expect(parseAgaveFeatures(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('watching the clusters', () => {
  const quiet = () => ({
    'mainnet-beta': cluster({ [SLOT_200MS]: 'pending', [VOTE_STATE_V4]: 'active' }),
    testnet: cluster({ [SLOT_200MS]: 'active', [ALPENGLOW]: 'active', [VOTE_STATE_V4]: 'active' }),
    devnet: cluster({
      [SLOT_200MS]: 'active',
      [ALPENGLOW]: 'active',
      [VOTE_STATE_V4]: 'active',
      [STAKE_V5]: 'lamports',
    }),
  });

  it('takes the first run for a baseline, and lists what is on the way to mainnet-beta with its entry', async () => {
    const { snapshot, report } = await watch(quiet());
    expect(report).toMatchObject({ baseline: true, declared: 9, newlyDeclared: [], changes: [], drafts: [] });
    expect(report.inRegistry).toBe(2);
    expect(report.upcoming.map((item) => [item.module, item.entry])).toEqual([
      ['alpenglow', 'alpenglow'],
      ['reduce_slot_time_to_200ms', 'slot-duration'],
    ]);
    const stake = snapshot.features.find((feature) => feature.address === STAKE_V5);
    expect(stake?.state.devnet).toBe('unknown');
    expect(stake?.unknownBecause?.devnet).toContain('not by the feature program');
    expect(watchReportMarkdown(report)).toContain('First run: this snapshot is the baseline.');
  });

  it('reports what changed since the last snapshot, and drafts only what the registry does not name', async () => {
    const { snapshot } = await watch(quiet());
    // Since then: agave declared a gate it did not before, testnet activated vote state v4 elsewhere, …
    const before = {
      ...snapshot,
      features: snapshot.features
        .filter((feature) => feature.address !== STAKE_V5)
        .map((feature) =>
          feature.address === VOTE_STATE_V4 || feature.address === ALPENGLOW
            ? { ...feature, state: { ...feature.state, testnet: 'absent' as const } }
            : feature,
        ),
    };
    const { report } = await watch(quiet(), before);
    expect(report.baseline).toBe(false);
    expect(report.newlyDeclared).toEqual([
      expect.objectContaining({ module: 'upgrade_bpf_stake_program_to_v5', simd: 'SIMD-0490' }),
    ]);
    expect(report.newlyDeclared[0]?.entry).toBeUndefined();
    expect(report.changes).toEqual([
      expect.objectContaining({
        module: 'alpenglow',
        cluster: 'testnet',
        from: 'absent',
        to: 'active',
        entry: 'alpenglow',
      }),
      expect.objectContaining({
        module: 'vote_state_v4',
        cluster: 'testnet',
        from: 'absent',
        to: 'active',
        simd: 'SIMD-0185',
      }),
      expect.objectContaining({
        module: 'upgrade_bpf_stake_program_to_v5',
        cluster: 'devnet',
        from: 'absent',
        to: 'unknown',
      }),
    ]);
    // alpenglow has an entry: no draft. The two others do not.
    expect(report.drafts.map((draft) => [draft.file, draft.features])).toEqual([
      ['simd-0185.yaml', ['vote_state_v4']],
      ['simd-0490.yaml', ['upgrade_bpf_stake_program_to_v5']],
    ]);
    const text = watchReportMarkdown(report);
    expect(text).toContain('testnet: `vote_state_v4` absent → active (SIMD-0185) — **not in the registry**');
    expect(text).toContain('entry `alpenglow`');

    // A third run on the same chain state reports nothing new.
    const again = await watch(quiet(), (await watch(quiet(), before)).snapshot);
    expect(again.report).toMatchObject({ newlyDeclared: [], changes: [], drafts: [] });
  });

  it('reads a cluster a hundred addresses at a time', async () => {
    const many = Array.from(
      { length: 250 },
      (_, index) =>
        `pub mod gate_${index} {\n    solana_pubkey::declare_id!("${BASE58[index % 58]}${BASE58[Math.floor(index / 58)]}${'1'.repeat(30)}");\n}\n`,
    ).join('');
    const names = Array.from(
      { length: 250 },
      (_, index) => `        (gate_${index}::id(), "gate ${index}"),`,
    ).join('\n');
    const clusters = quiet();
    const { report } = await watch(clusters, undefined, `${many}${names}\n`);
    expect(report.declared).toBe(250);
    expect((clusters['mainnet-beta'] as ReturnType<typeof cluster>).asked).toEqual([100, 100, 50]);
  });

  it('refuses to write a snapshot from a source with no gates or a cluster that did not answer', async () => {
    await expect(watch(quiet(), undefined, '404: Not Found')).rejects.toThrow('no feature gate found');
    const down = {
      ...quiet(),
      testnet: { getAccounts: () => Promise.reject(new Error('fetch failed')) },
    };
    await expect(watch(down)).rejects.toThrow('testnet did not answer: fetch failed');
  });
});

describe('a draft', () => {
  const features = parseAgaveFeatures(excerpt);
  const feature = (module: string) => features.find((item) => item.module === module) as DeclaredFeature;

  it('is a schema-2 entry the validator refuses only for its DRAFT: markers, and says how to finish it', () => {
    const draft = draftEntry([feature('vote_state_v4')], AGAVE);
    const result = validateEntryYaml(draft.yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(['breaks[0].summary', 'fix[0].summary']);
    expect(result.issues[0]).toMatchObject({
      message: 'Entry is a draft written by the watcher',
      hint: 'Write what the primary source says, add it to sources, and remove every DRAFT: marker.',
    });
    // Written out by a person, it passes.
    const written = draft.yaml
      .replace(
        "'DRAFT: what this change breaks, in the words of its SIMD - not written yet.'",
        'Vote accounts change layout.',
      )
      .replace(
        "'DRAFT: how to fix it, from the SIMD - not written yet.'",
        'Read vote accounts with the v4 layout.',
      );
    expect(validateEntryYaml(written)).toMatchObject({
      ok: true,
      entry: { id: 'simd-0185', schema_version: 2 },
    });
  });

  it('keeps quotes and nested module names in a description intact', () => {
    for (const module of ['credits_auto_rewind', 'full_inflation::mainnet::certusone::vote']) {
      const draft = draftEntry([feature(module)], AGAVE);
      const result = validateEntryYaml(draft.yaml.replaceAll('DRAFT: ', ''));
      expect(result.ok, draft.yaml).toBe(true);
      if (!result.ok) continue;
      const entry = result.entry as Entry & { applies: { activations: { label: string; effect: string }[] } };
      expect(entry.applies.activations[0]?.label).toBe(module);
      expect(entry.applies.activations[0]?.effect).toContain(feature(module).description);
    }
  });
});
