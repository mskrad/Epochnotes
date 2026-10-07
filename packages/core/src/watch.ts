import { type FeatureAccountSource, type FeatureState, readFeatureStatus } from './feature-status.js';
import { type Entry, featureGatesOf } from './schema.js';

/**
 * The watcher of Solana: what agave declares as feature gates, and what each cluster says about them, compared
 * with the last time it looked. It finds; it does not write entries. What it finds outside the registry becomes
 * a draft that a person completes from the primary source and signs — or throws away.
 */

export const WATCHED_CLUSTERS = ['mainnet-beta', 'testnet', 'devnet'] as const;
/** A Solana cluster the watcher reads. */
export type WatchedCluster = (typeof WATCHED_CLUSTERS)[number];

/** Marks a draft written by the watcher; the validator refuses an entry that still carries it. */
export const DRAFT_MARKER = 'DRAFT:';
export const DRAFT_PLACEHOLDER = '- not written yet.';

const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
const MARKER_ANY_SPELLING = /^\s*draft\s*:/;

export function readsAsDraft(text: string): boolean {
  const plain = text.normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
  return MARKER_ANY_SPELLING.test(plain) || plain.includes(DRAFT_PLACEHOLDER);
}

/** A feature gate as agave declares it: module, address, the name it is registered under. */
export interface DeclaredFeature {
  /** The module path in agave, `full_inflation::mainnet::certusone::vote` for a nested one. */
  module: string;
  address: string;
  /** The text agave registers the feature under, `SIMD-0525: Reduce slot time to 200ms`. */
  description?: string;
  /** `SIMD-0525`, when the description names one. */
  simd?: string;
}

type WatchState = 'absent' | 'scheduled' | 'active' | 'unknown';

/** A declared gate with its state on every watched cluster. */
export interface WatchedFeature extends DeclaredFeature {
  state: Record<WatchedCluster, WatchState>;
  /** The activation slot on the clusters where the feature is active. */
  activatedAt: Partial<Record<WatchedCluster, string>>;
  /** Why the state is unknown on the clusters where it is: what the account held instead of a feature. */
  unknownBecause?: Partial<Record<WatchedCluster, string>>;
}

/** Everything one look read, kept to compare the next look with. */
export interface WatchSnapshot {
  watcher: 1;
  agave: { repository: string; commit: string; retrieved: string };
  /** The slot each cluster was read at. */
  clusters: Record<WatchedCluster, { slot: string }>;
  features: WatchedFeature[];
}

/** A gate whose state on one cluster differs from the last snapshot. */
export interface WatchChange {
  module: string;
  address: string;
  simd?: string;
  cluster: WatchedCluster;
  from: WatchState;
  to: WatchState;
  /** The registry entry that names this gate, when there is one. */
  entry?: string;
}

/** A draft entry written by the watcher, and the gates it covers. */
export interface WatchDraft {
  /** File name for the draft, `simd-0525.yaml`. */
  file: string;
  yaml: string;
  features: string[];
}

/**
 * What a look found: counts, gates on the way to mainnet-beta, what changed since the last look, and drafts.
 */
export interface WatchReport {
  /** True on the first run: nothing to compare with, the snapshot becomes the baseline. */
  baseline: boolean;
  agave: WatchSnapshot['agave'];
  clusters: WatchSnapshot['clusters'];
  declared: number;
  inRegistry: number;
  newlyDeclared: (DeclaredFeature & { entry?: string })[];
  /** Gates not active on mainnet-beta that testnet or devnet already run, or that mainnet-beta has scheduled. */
  upcoming: (WatchedFeature & { entry?: string })[];
  changes: WatchChange[];
  drafts: WatchDraft[];
}

const MODULE_OPEN = /^(\s*)pub mod (\w+) \{\s*$/;
const BLOCK_CLOSE = /^(\s*)\}\s*$/;
const DECLARE = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/;
const ID_CALL = '::id(),';
const DEEPEST_FEATURE_MODULE = 8;
const PATH_CHARACTER = /[\w:]/;
const LINE_CONTINUATION = 'line-continuation';

function rustStringFrom(lines: string[], start: number, opening: string): string | undefined {
  if (!opening.startsWith('"')) return undefined;
  let text = '';
  let piece = opening.slice(1);
  for (let at = start; at < Math.min(lines.length, start + 8); at += 1) {
    let continued = false;
    for (let index = 0; index < piece.length; index += 1) {
      const character = piece[index];
      if (character === '"') return text;
      if (character !== '\\') {
        text += character;
        continue;
      }
      const escaped = index + 1 < piece.length ? piece[index + 1] : LINE_CONTINUATION;
      if (escaped === LINE_CONTINUATION) continued = true;
      else text += escaped === 'n' ? '\n' : escaped;
      index += 1;
    }
    if (!continued) return undefined;
    piece = (lines[at + 1] ?? '').trimStart();
  }
  return undefined;
}

function registration(lines: string[], index: number): { module: string; name?: string } | undefined {
  const line = lines[index] ?? '';
  const call = line.indexOf(ID_CALL);
  if (call === -1) return undefined;
  let begin = call;
  while (begin > 0 && PATH_CHARACTER.test(line[begin - 1] ?? '')) begin -= 1;
  if (begin === call) return undefined;
  const rest = line.slice(call + ID_CALL.length).trimStart();
  const name =
    rest === ''
      ? rustStringFrom(lines, index + 1, (lines[index + 1] ?? '').trimStart())
      : rustStringFrom(lines, index, rest);
  return { module: line.slice(begin, call), ...(name === undefined ? {} : { name }) };
}

/**
 * The feature gates agave declares, read line by line in one pass: a module opens on its own line, its
 * declare_id may sit on any line inside it, modules nest (`full_inflation`), and the names live in
 * FEATURE_NAMES as `module::id(), "text"`, on one line or two. Every step is linear in the line: the file is
 * data from another repository.
 */
export function parseAgaveFeatures(text: string): DeclaredFeature[] {
  const lines = text.split('\n');
  const features: DeclaredFeature[] = [];
  const stack: { name: string; indent: number }[] = [];
  const names = new Map<string, string>();
  lines.forEach((line, index) => {
    const content = line.trimStart();
    if (content.startsWith('//')) return;
    const open = MODULE_OPEN.exec(line);
    if (open !== null) {
      const indent = (open[1] ?? '').length;
      if (indent === 0) stack.length = 0;
      if (stack.length < DEEPEST_FEATURE_MODULE) stack.push({ name: open[2] ?? '', indent });
      return;
    }
    const close = BLOCK_CLOSE.exec(line);
    if (close !== null) {
      const indent = (close[1] ?? '').length;
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      return;
    }
    if (content !== '' && content.length === line.length) stack.length = 0;
    const declared = DECLARE.exec(line);
    if (declared !== null && stack.length > 0) {
      features.push({ module: stack.map((item) => item.name).join('::'), address: declared[1] ?? '' });
      return;
    }
    const registered = stack.length === 0 ? registration(lines, index) : undefined;
    if (registered?.name !== undefined && !names.has(registered.module))
      names.set(registered.module, registered.name);
  });
  // A gate is what FEATURE_NAMES registers: a declare_id nested in a feature module (a program buffer) is not one.
  return features
    .filter((feature) => names.has(feature.module))
    .map((feature) => {
      const description = names.get(feature.module);
      const simd = /\bSIMD-?\s?(\d{1,4})\b/i.exec(description ?? '')?.[1];
      return {
        ...feature,
        ...(description === undefined ? {} : { description }),
        ...(simd === undefined ? {} : { simd: `SIMD-${simd.padStart(4, '0')}` }),
      };
    });
}

function stateOf(feature: FeatureState): { state: WatchState; activatedAt?: string; because?: string } {
  switch (feature.state) {
    case 'absent':
      return { state: 'absent' };
    case 'pending':
      return { state: 'scheduled' };
    case 'active':
      return { state: 'active', activatedAt: feature.activatedAt.toString() };
    case 'unreadable':
      return { state: 'unknown', because: feature.reason };
  }
}

/** One request per hundred addresses: the most getMultipleAccounts takes. */
async function readCluster(
  source: FeatureAccountSource,
  addresses: string[],
): Promise<{ slot: string; states: Map<string, FeatureState> }> {
  const states = new Map<string, FeatureState>();
  let slot = 0n;
  for (let start = 0; start < addresses.length; start += 100) {
    const report = await readFeatureStatus(source, addresses.slice(start, start + 100));
    if (!report.ok) throw new Error(report.error);
    if (report.slot > slot) slot = report.slot;
    for (const [address, state] of report.states) states.set(address, state);
  }
  return { slot: slot.toString(), states };
}

const slugOf = (feature: DeclaredFeature) =>
  (feature.simd?.toLowerCase() ?? feature.module.replaceAll('::', '-').replaceAll('_', '-'))
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 64);

const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * A draft of an entry for gates the registry does not name. It is schema 2 and says only what agave says: the
 * gates, their modules, the text they are registered under, the commit. What breaks and how to fix it is left
 * to a person reading the SIMD, and the markers keep the draft from being published as it is.
 */
export function draftEntry(features: DeclaredFeature[], agave: WatchSnapshot['agave']): WatchDraft {
  const first = features[0] as DeclaredFeature;
  const title = first.description?.replace(/^SIMD-?\s?\d+:\s*/i, '') ?? first.module;
  const activations = features
    .map(
      (feature) => `    - kind: feature-account
      chain: solana
      address: ${feature.address}
      label: ${feature.module}
      effect: ${quoted(`Feature gate registered in agave as "${feature.description ?? feature.module}".`)}`,
    )
    .join('\n');
  const yaml = `# Written by \`epochnotes watch solana\` from agave ${agave.commit.slice(0, 12)} on ${agave.retrieved}.
# A draft, not an entry: write what breaks and how to fix it from the SIMD itself, add the SIMD as a source,
# and remove every ${DRAFT_MARKER} marker. Until then \`epochnotes registry validate\` refuses it.
schema_version: 2
id: ${slugOf(first)}
rev: 1
axis: protocol
subject:
  standard: simd
  name: ${first.simd ?? first.module}
  title: ${quoted(title)}
applies:
  activations:
${activations}
breaks:
  - surface: program
    summary: ${quoted(`${DRAFT_MARKER} what this change breaks, in the words of its SIMD ${DRAFT_PLACEHOLDER}`)}
fix:
  - summary: ${quoted(`${DRAFT_MARKER} how to fix it, from the SIMD ${DRAFT_PLACEHOLDER}`)}
sources:
  - kind: source-code
    ref: ${agave.repository}/blob/${agave.commit}/feature-set/src/lib.rs
    retrieved: ${quoted(agave.retrieved)}
    note: ${quoted(`Declares ${features.map((feature) => `${feature.module} (${feature.address})`).join(', ')}.`)}
`;
  return { file: `${slugOf(first)}.yaml`, yaml, features: features.map((feature) => feature.module) };
}

/** What one look needs: the agave source, the clusters, the last snapshot if any, and the registry. */
export interface WatchOptions {
  /** The text of agave's feature-set/src/lib.rs at `agave.commit`. */
  agaveSource: string;
  agave: WatchSnapshot['agave'];
  clusters: Record<WatchedCluster, FeatureAccountSource>;
  previous?: WatchSnapshot;
  /** Entries of the registry, to tell a gate it names from one nobody wrote about. */
  entries: Entry[];
}

/** One look: the snapshot to keep for next time, and what changed since the last one. */
export async function watchSolana(
  options: WatchOptions,
): Promise<{ snapshot: WatchSnapshot; report: WatchReport }> {
  const declared = parseAgaveFeatures(options.agaveSource);
  if (declared.length === 0)
    throw new Error('no feature gate found in the agave source: its layout changed, or this is not the file');
  const addresses = declared.map((feature) => feature.address);
  const readings = {} as Record<WatchedCluster, { slot: string; states: Map<string, FeatureState> }>;
  for (const cluster of WATCHED_CLUSTERS) {
    try {
      readings[cluster] = await readCluster(options.clusters[cluster], addresses);
    } catch (error) {
      throw new Error(`${cluster} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const features: WatchedFeature[] = declared.map((feature) => {
    const state = {} as Record<WatchedCluster, WatchState>;
    const activatedAt: Partial<Record<WatchedCluster, string>> = {};
    const unknownBecause: Partial<Record<WatchedCluster, string>> = {};
    for (const cluster of WATCHED_CLUSTERS) {
      const read = stateOf(
        readings[cluster].states.get(feature.address) ?? {
          state: 'unreadable',
          reason: 'the cluster did not return this account',
        },
      );
      state[cluster] = read.state;
      if (read.activatedAt !== undefined) activatedAt[cluster] = read.activatedAt;
      if (read.because !== undefined) unknownBecause[cluster] = read.because;
    }
    return {
      ...feature,
      state,
      activatedAt,
      ...(Object.keys(unknownBecause).length === 0 ? {} : { unknownBecause }),
    };
  });
  const snapshot: WatchSnapshot = {
    watcher: 1,
    agave: options.agave,
    clusters: Object.fromEntries(
      WATCHED_CLUSTERS.map((cluster) => [cluster, { slot: readings[cluster].slot }]),
    ) as WatchSnapshot['clusters'],
    features,
  };

  const named = new Map<string, string>();
  for (const entry of options.entries)
    for (const gate of featureGatesOf(entry)) named.set(gate.address, entry.id);
  const withEntry = <T extends { address: string }>(item: T) => {
    const entry = named.get(item.address);
    return entry === undefined ? item : { ...item, entry };
  };

  const before = new Map((options.previous?.features ?? []).map((feature) => [feature.address, feature]));
  const baseline = options.previous === undefined;
  const newlyDeclared = baseline
    ? []
    : declared.filter((feature) => !before.has(feature.address)).map(withEntry);
  const changes: WatchChange[] = [];
  if (!baseline)
    for (const feature of features) {
      const was = before.get(feature.address);
      for (const cluster of WATCHED_CLUSTERS) {
        const from = was?.state[cluster] ?? 'absent';
        if (from !== feature.state[cluster])
          changes.push(
            withEntry({
              module: feature.module,
              address: feature.address,
              ...(feature.simd === undefined ? {} : { simd: feature.simd }),
              cluster,
              from,
              to: feature.state[cluster],
            }),
          );
      }
    }

  // A draft for what moved and nobody wrote about: one per SIMD, or per gate without one.
  const unnamed = new Map<string, DeclaredFeature[]>();
  const moved = new Set([
    ...newlyDeclared.map((item) => item.address),
    ...changes.map((item) => item.address),
  ]);
  for (const feature of declared)
    if (moved.has(feature.address) && !named.has(feature.address)) {
      const key = feature.simd ?? feature.module;
      unnamed.set(key, [...(unnamed.get(key) ?? []), feature]);
    }
  const drafts = [...unnamed.values()].map((group) => draftEntry(group, options.agave));

  return {
    snapshot,
    report: {
      baseline,
      agave: options.agave,
      clusters: snapshot.clusters,
      declared: declared.length,
      inRegistry: declared.filter((feature) => named.has(feature.address)).length,
      newlyDeclared,
      upcoming: features
        .filter(
          (feature) =>
            feature.state['mainnet-beta'] === 'scheduled' ||
            (feature.state['mainnet-beta'] !== 'active' &&
              (feature.state.testnet === 'active' || feature.state.devnet === 'active')),
        )
        .map(withEntry),
      changes,
      drafts,
    },
  };
}

/** The report as text a person reads first: what changed, what the registry already says, what is drafted. */
export function watchReportMarkdown(report: WatchReport): string {
  const lines = [
    '# Solana watcher',
    '',
    `agave ${report.agave.commit.slice(0, 12)}, read ${report.agave.retrieved}; clusters read at ${WATCHED_CLUSTERS.map((cluster) => `${cluster} slot ${report.clusters[cluster].slot}`).join(', ')}.`,
    `${report.declared} feature gates declared, ${report.inRegistry} of them named by the registry.`,
    '',
  ];
  const covered = (entry: string | undefined) =>
    entry === undefined ? ' — **not in the registry**' : ` — entry \`${entry}\``;
  lines.push(`## On the way to mainnet-beta (${report.upcoming.length})`, '');
  for (const item of report.upcoming)
    lines.push(
      `- \`${item.module}\`${item.simd === undefined ? '' : ` (${item.simd})`}: ${WATCHED_CLUSTERS.map((cluster) => `${cluster} ${item.state[cluster]}`).join(', ')}${covered(item.entry)}`,
    );
  lines.push('');
  if (report.baseline) {
    lines.push('First run: this snapshot is the baseline. Changes are reported from the next run on.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`## Newly declared in agave (${report.newlyDeclared.length})`, '');
  for (const item of report.newlyDeclared)
    lines.push(
      `- \`${item.module}\` ${item.address} — ${item.description ?? 'no name'}${covered(item.entry)}`,
    );
  lines.push('', `## State changes (${report.changes.length})`, '');
  for (const item of report.changes)
    lines.push(
      `- ${item.cluster}: \`${item.module}\` ${item.from} → ${item.to}${item.simd === undefined ? '' : ` (${item.simd})`}${covered(item.entry)}`,
    );
  lines.push('', `## Drafts (${report.drafts.length})`, '');
  for (const draft of report.drafts) lines.push(`- \`${draft.file}\`: ${draft.features.join(', ')}`);
  if (report.drafts.length > 0)
    lines.push(
      '',
      'A draft is not an entry: a person writes what breaks and how to fix it from the SIMD, then signs.',
    );
  return `${lines.join('\n')}\n`;
}
