import {
  type ActivationReader,
  type ActivationReading,
  type ChainReading,
  readActivations,
} from './activation-status.js';
import { validatePath } from './load.js';
import { type Cluster, compareLogWithChain, fetchRevocation, type OnchainRevocation } from './onchain.js';
import type { Entry } from './schema.js';
import type { Issue } from './validate.js';
import type { Manifest } from './version.js';
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
      /**
       * A publisher withdraws an entry with a record on chain; the signed log alone does not show it. `not-checked`
       * means a withdrawn entry may be among the entries.
       */
      revocations: 'not-checked' | 'checked';
    }
  | { verified: false; workingCopy: string; warning: string };

export interface EntryReading {
  entry: Entry;
  /** Present when a chain was asked about: what it says about each activation of the entry on that chain. */
  activations?: ActivationReading[];
  /** Present when a chain was asked about and the entry names no activation on it: why. */
  noActivation?: string;
  /** Only with `includeRevoked`: the publisher withdrew this entry on chain. Do not rely on it. */
  revokedOnChain?: true;
}

export type RegistryReading =
  | {
      ok: true;
      provenance: Provenance;
      network?: Omit<ChainReading, 'activations' | 'withoutActivation'>;
      /** The entries a consumer may rely on. Entries withdrawn on chain are not here. */
      entries: EntryReading[];
      /** Entries of this version that the publisher withdrew on chain. Empty when revocations were not checked. */
      revoked: { id: string; atVersion: number; address: string }[];
      unknownIds: string[];
    }
  | { ok: false; issues: Issue[] };

/** What a reader needs from the chain. */
export interface ChainSource {
  differences(log: Manifest[]): Promise<Issue[]>;
  revocation(publisher: string, entryId: string): Promise<OnchainRevocation | undefined>;
}

export const chainSourceOf = (cluster: Cluster): ChainSource => ({
  differences: (log) => compareLogWithChain(cluster, log),
  revocation: (publisher, entryId) => fetchRevocation(cluster, publisher, entryId),
});

export interface ReadOptions {
  /** The signed log to read from. Without it, `workingCopy` must be given. */
  log?: VerifyOptions;
  /** A directory of entry files that were never signed: for development only, and labelled as such. */
  workingCopy?: string;
  ids?: string[];
  /** Compare the log with the chain and look up revocations. */
  onchain?: Cluster;
  /** How the chain is asked; the default asks the registry program on `onchain`. */
  chain?: ChainSource;
  /** Return withdrawn entries too, marked. For diagnostics: a consumer never sets this. */
  includeRevoked?: boolean;
  /** Read the state of every activation from the chain behind this reader; `chain` is what the user asked for. */
  status?: { reader: ActivationReader; chain?: string };
}

/**
 * The entries a consumer may rely on, with their provenance. Nothing is returned from a log that does not
 * verify: a consumer that cannot check an entry must not answer from it.
 */
export async function readRegistry(options: ReadOptions): Promise<RegistryReading> {
  const chainSource =
    options.chain ?? (options.onchain === undefined ? undefined : chainSourceOf(options.onchain));
  // Asking for the chain and not getting it must never pass in silence.
  if (chainSource !== undefined && options.log === undefined)
    throw new Error(
      'unsigned files have no publisher to ask the chain about: --onchain needs the signed log',
    );
  if (options.includeRevoked && chainSource === undefined)
    throw new Error('revocations are known only from the chain: --include-revoked needs --onchain');
  let entries: Entry[];
  let provenance: Provenance;
  if (options.log !== undefined) {
    const version = await verifyLatestVersion(options.log);
    if (!version.ok) return { ok: false, issues: version.issues };
    let chain: 'not-checked' | 'matches' = 'not-checked';
    if (chainSource !== undefined) {
      const differences = await chainSource.differences(version.log);
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
      revocations: chainSource === undefined ? 'not-checked' : 'checked',
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

  // Revocations are looked up for every entry of the version, not only the ones asked for: whatever is built
  // on this reading (a repository check, a probe) must not run on a withdrawn entry either.
  const revoked: { id: string; atVersion: number; address: string }[] = [];
  if (chainSource !== undefined && provenance.verified) {
    for (const entry of entries) {
      const record = await chainSource.revocation(provenance.publisher, entry.id);
      if (record !== undefined)
        revoked.push({ id: entry.id, atVersion: Number(record.atVersion), address: record.address });
    }
  }
  const isRevoked = (id: string) => revoked.some((record) => record.id === id);

  const asked = options.ids ?? [];
  // Asking for a withdrawn entry by name is answered with a refusal, in the words `registry verify` uses.
  if (!options.includeRevoked && asked.some(isRevoked)) {
    return {
      ok: false,
      issues: revoked
        .filter((record) => asked.includes(record.id))
        .map((record) => ({
          path: record.id,
          message: `Entry was revoked on chain by its publisher (at version ${record.atVersion})`,
          hint: `Do not rely on this entry. The revocation account is ${record.address}.`,
        }))
        .concat(
          asked
            .filter((id) => !entries.some((entry) => entry.id === id))
            .map((id) => ({ path: id, message: 'No such entry in this version', hint: 'Check the id.' })),
        ),
    };
  }

  const usable = options.includeRevoked ? entries : entries.filter((entry) => !isRevoked(entry.id));
  const wanted = asked.length === 0 ? usable : usable.filter((entry) => asked.includes(entry.id));
  const unknownIds = asked.filter((id) => !entries.some((entry) => entry.id === id));
  const readings: EntryReading[] = wanted.map((entry) =>
    isRevoked(entry.id) ? { entry, revokedOnChain: true } : { entry },
  );

  let network: Omit<ChainReading, 'activations' | 'withoutActivation'> | undefined;
  if (options.status !== undefined) {
    let read: ChainReading;
    try {
      read = await readActivations(
        readings.map((reading) => reading.entry),
        options.status.reader,
        options.status.chain,
      );
    } catch (error) {
      // An unreachable or mistaken endpoint is an environment failure, not a finding: no status is ever guessed.
      throw new Error(
        `cannot read chain ${options.status.chain ?? 'behind that endpoint'}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const { activations, withoutActivation, ...where } = read;
    network = where;
    for (const reading of readings) {
      reading.activations = activations.filter((item) => item.entry === reading.entry.id);
      const note = withoutActivation.find((item) => item.entry === reading.entry.id)?.reason;
      if (note !== undefined) reading.noActivation = note;
    }
  }
  return {
    ok: true,
    provenance,
    ...(network === undefined ? {} : { network }),
    entries: readings,
    revoked,
    unknownIds,
  };
}
