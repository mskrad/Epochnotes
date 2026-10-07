import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CLUSTERS, rpcFeatureAccountSource } from './feature-status.js';
import { validatePath } from './load.js';
import { type WatchReport, watchReportMarkdown, type WatchSnapshot, watchSolana } from './watch.js';

const AGAVE = 'https://github.com/anza-xyz/agave';
const TIMEOUT_MS = 30_000;

async function fetchText(url: string, accept?: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'epochnotes-watch', ...(accept === undefined ? {} : { accept }) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.text();
}

/** The commit agave's default branch points at now: the snapshot names it, so a reading can be repeated. */
async function agaveHead(): Promise<string> {
  const sha = (
    await fetchText(
      'https://api.github.com/repos/anza-xyz/agave/commits/master',
      'application/vnd.github.sha',
    )
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`GitHub answered "${sha.slice(0, 60)}" for the head of agave`);
  return sha;
}

function snapshotAt(path: string): WatchSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const snapshot = parsed as Partial<WatchSnapshot> | null;
  const wellFormed =
    snapshot !== null &&
    typeof snapshot === 'object' &&
    snapshot.watcher === 1 &&
    Array.isArray(snapshot.features) &&
    snapshot.features.length > 0 &&
    snapshot.features.every(
      (feature) =>
        typeof feature?.address === 'string' && typeof feature.state === 'object' && feature.state !== null,
    );
  if (!wellFormed) throw new Error(`${path} is not a snapshot this watcher wrote`);
  return snapshot as WatchSnapshot;
}

export interface WatchFiles {
  /** The snapshot of the last look: read when present, replaced after a successful look. */
  state: string;
  /** Where report.json, report.md and drafts/ go. */
  out: string;
  /** The entries that tell a covered gate from an uncovered one. */
  registry: string;
  /** An agave commit to read instead of the head of its default branch. */
  agaveRef?: string;
}

/**
 * One look at Solana from the public endpoints: agave at a pinned commit, three clusters over JSON-RPC.
 * Reads only. Nothing is written unless every source answered, so a failed look leaves the last snapshot as it was.
 */
export async function watchSolanaFiles(files: WatchFiles): Promise<WatchReport> {
  if (files.agaveRef !== undefined && !/^[0-9a-f]{40}$/.test(files.agaveRef))
    throw new Error(`--agave-ref takes a full commit hash (40 hex characters), not "${files.agaveRef}"`);
  const registry = validatePath(files.registry);
  const entries = registry.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
  const previous = existsSync(files.state) ? snapshotAt(files.state) : undefined;
  const commit = files.agaveRef ?? (await agaveHead());
  const agaveSource = await fetchText(
    `https://raw.githubusercontent.com/anza-xyz/agave/${commit}/feature-set/src/lib.rs`,
  );
  const { snapshot, report } = await watchSolana({
    agaveSource,
    agave: { repository: AGAVE, commit, retrieved: new Date().toISOString().slice(0, 10) },
    clusters: {
      'mainnet-beta': rpcFeatureAccountSource(CLUSTERS['mainnet-beta']),
      testnet: rpcFeatureAccountSource(CLUSTERS.testnet),
      devnet: rpcFeatureAccountSource(CLUSTERS.devnet),
    },
    ...(previous === undefined ? {} : { previous }),
    entries,
  });
  mkdirSync(join(files.out, 'drafts'), { recursive: true });
  writeFileSync(join(files.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(files.out, 'report.md'), watchReportMarkdown(report));
  for (const draft of report.drafts) writeFileSync(join(files.out, 'drafts', draft.file), draft.yaml);
  // The snapshot last: if writing the report failed, the next look compares with the same snapshot again.
  mkdirSync(dirname(files.state), { recursive: true });
  writeFileSync(files.state, `${JSON.stringify(snapshot, null, 2)}\n`);
  return report;
}
