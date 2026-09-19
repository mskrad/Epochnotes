import { type FeatureAccountSource, type FeatureState, readFeatureStatus } from './feature-status.js';
import { validatePath } from './load.js';
import { type Cluster, compareLogWithChain, fetchRevocation } from './onchain.js';
import type { Entry } from './schema.js';
import type { Issue } from './validate.js';
import { type VerifyOptions, verifyLatestVersion } from './version-store.js';

/** Where the entries came from, and how far they can be trusted. A consumer must show this, not hide it. */
export type Provenance =
  | {
      verified: true;
      publisher: string;
      version: number;
      merkleRoot: string;
      published: string;
      versionsInLog: number;
      contentSource: string;
      /** `not-checked` unless the log was compared with the chain. */
      chain: 'not-checked' | 'matches';
    }
  | { verified: false; workingCopy: string; warning: string };

export interface GateReading {
  label: string;
  address: string;
  status: FeatureState;
}

export interface EntryReading {
  entry: Entry;
  /** Present when a cluster was asked about: what the network says about each gate of the entry. */
  gates?: GateReading[];
  /** Set when the publisher withdrew the entry on chain. */
  revokedOnChain?: boolean;
}

export type RegistryReading =
  | {
      ok: true;
      provenance: Provenance;
      network?: { cluster: string; slot: string };
      entries: EntryReading[];
      unknownIds: string[];
    }
  | { ok: false; issues: Issue[] };

export interface ReadOptions {
  /** The signed log to read from. Without it, `workingCopy` must be given. */
  log?: VerifyOptions;
  /** A directory of entry files that were never signed: for development only, and labelled as such. */
  workingCopy?: string;
  ids?: string[];
  /** Compare the log with the chain and look up revocations. */
  onchain?: Cluster;
  /** Read the activation status of every gate from this cluster. */
  status?: { cluster: string; source: FeatureAccountSource };
}

/**
 * The entries a consumer may rely on, with their provenance. Nothing is returned from a log that does not
 * verify: a consumer that cannot check an entry must not answer from it.
 */
export async function readRegistry(options: ReadOptions): Promise<RegistryReading> {
  let entries: Entry[];
  let provenance: Provenance;
  if (options.log !== undefined) {
    const version = await verifyLatestVersion(options.log);
    if (!version.ok) return { ok: false, issues: version.issues };
    let chain: 'not-checked' | 'matches' = 'not-checked';
    if (options.onchain !== undefined) {
      const differences = await compareLogWithChain(options.onchain, version.log);
      if (differences.length > 0) return { ok: false, issues: differences };
      chain = 'matches';
    }
    entries = version.content.entries;
    provenance = {
      verified: true,
      publisher: version.manifest.publisher,
      version: version.manifest.n,
      merkleRoot: version.manifest.merkle_root,
      published: version.manifest.published,
      versionsInLog: version.log.length,
      contentSource: version.contentSource,
      chain,
    };
  } else if (options.workingCopy !== undefined) {
    const report = validatePath(options.workingCopy);
    if (!report.ok) {
      const issues = report.files.flatMap((file) =>
        file.issues.map((issue) => ({ ...issue, path: `${file.file}: ${issue.path}` })),
      );
      return { ok: false, issues: [...issues, ...report.registryIssues] };
    }
    entries = report.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
    provenance = {
      verified: false,
      workingCopy: options.workingCopy,
      warning: 'These entries were read from files that nobody signed. Treat them as a draft, and say so.',
    };
  } else {
    return {
      ok: false,
      issues: [
        {
          path: 'source',
          message: 'Neither a signed log nor a working copy was given',
          hint: 'Pass --versions, or --working-copy for unsigned files.',
        },
      ],
    };
  }

  const wanted =
    options.ids === undefined || options.ids.length === 0
      ? entries
      : entries.filter((entry) => options.ids?.includes(entry.id));
  const unknownIds = (options.ids ?? []).filter((id) => !entries.some((entry) => entry.id === id));
  const readings: EntryReading[] = wanted.map((entry) => ({ entry }));

  if (options.onchain !== undefined && provenance.verified) {
    for (const reading of readings) {
      reading.revokedOnChain =
        (await fetchRevocation(options.onchain, provenance.publisher, reading.entry.id)) !== undefined;
    }
  }

  let network: { cluster: string; slot: string } | undefined;
  if (options.status !== undefined) {
    const addresses = readings.flatMap((reading) =>
      (reading.entry.applies.gates ?? []).map((gate) => gate.address),
    );
    const report = await readFeatureStatus(options.status.source, addresses);
    // An unreachable cluster is an environment failure, not a finding about the registry: no status is ever guessed.
    if (!report.ok) throw new Error(`cluster ${options.status.cluster} did not answer: ${report.error}`);
    network = { cluster: options.status.cluster, slot: report.slot.toString() };
    for (const reading of readings) {
      reading.gates = (reading.entry.applies.gates ?? []).map((gate) => ({
        label: gate.label,
        address: gate.address,
        status: report.states.get(gate.address) ?? {
          state: 'unreadable',
          reason: 'no state returned for this gate',
        },
      }));
    }
  }
  return {
    ok: true,
    provenance,
    ...(network === undefined ? {} : { network }),
    entries: readings,
    unknownIds,
  };
}
