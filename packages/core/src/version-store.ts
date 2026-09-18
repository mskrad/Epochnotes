import type { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createKeyPairFromBytes, getAddressFromPublicKey } from '@solana/kit';

import { type ContentAttempt, ContentUnavailableError, fetchCommittedContent } from './content-source.js';
import { validatePath } from './load.js';
import { verifyMerkleProof } from './merkle.js';
import type { Entry } from './schema.js';
import type { Issue } from './validate.js';
import {
  buildVersion,
  type EntryProof,
  type Manifest,
  proveEntry,
  signManifest,
  verifyContent,
  verifyLog,
  type VersionContent,
} from './version.js';

/** Layout of a versions directory: `<n>.json` manifests and `<merkle_root>.jsonl` content files. */
const manifestFile = (dir: string, n: number) => join(dir, `${n}.json`);
const contentFile = (dir: string, root: string) => join(dir, `${root}.jsonl`);

export function readRawLog(versionsDir: string): unknown[] {
  if (!existsSync(versionsDir)) return [];
  return readdirSync(versionsDir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((name) => JSON.parse(readFileSync(join(versionsDir, name), 'utf8')) as unknown);
}

export function readTrustedPublishers(file: string): string[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    publishers?: { key?: unknown; status?: unknown }[];
  };
  return (parsed.publishers ?? [])
    .filter((publisher) => publisher.status === 'active' && typeof publisher.key === 'string')
    .map((publisher) => publisher.key as string);
}

/** A publisher key in the format `solana-keygen` writes: a JSON array of the 64 secret-key bytes. */
export async function loadPublisherKey(
  keyFile: string,
): Promise<{ address: string; privateKey: webcrypto.CryptoKey }> {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(keyFile, 'utf8')) as number[]);
  const pair = await createKeyPairFromBytes(bytes);
  return { address: await getAddressFromPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

export type VerifiedVersion =
  | { ok: true; manifest: Manifest; log: Manifest[]; content: VersionContent; contentSource: string }
  | { ok: false; issues: Issue[]; attempts?: ContentAttempt[] };

/**
 * Verifies a publisher's log and the content of its latest version without trusting the server:
 * signatures and the prev_root chain first, then the content against the hash and root it commits to.
 */
export async function verifyLatestVersion(options: {
  versionsDir: string;
  trustedPublishers: string[];
  mirrors?: string[];
}): Promise<VerifiedVersion> {
  const log = await verifyLog(readRawLog(options.versionsDir), options.trustedPublishers);
  if (!log.ok) return log;
  const manifest = log.manifests[log.manifests.length - 1] as Manifest;
  const local = contentFile(options.versionsDir, manifest.merkle_root);
  try {
    const fetched = await fetchCommittedContent({
      uri: manifest.uri,
      hash: manifest.content_hash,
      ...(existsSync(local) ? { localFile: local } : {}),
      ...(options.mirrors === undefined ? {} : { mirrors: options.mirrors }),
    });
    const content = verifyContent(manifest, fetched.bytes);
    if (!content.ok) return content;
    return {
      ok: true,
      manifest,
      log: log.manifests,
      content: content.content,
      contentSource: fetched.source,
    };
  } catch (error) {
    if (!(error instanceof ContentUnavailableError)) throw error;
    return {
      ok: false,
      attempts: error.attempts,
      issues: [
        {
          path: `version ${manifest.n}`,
          message: error.message,
          hint: 'Serve the content file at the manifest uri, or keep it next to the manifests.',
        },
      ],
    };
  }
}

export type EntryVerification =
  | { ok: true; manifest: Manifest; versions: number; contentSource: string; proof: EntryProof }
  | { ok: false; issues: Issue[] };

/** Proves that an entry belongs to the latest verified version of the log. */
export async function verifyEntry(options: {
  versionsDir: string;
  trustedPublishers: string[];
  entryId: string;
  mirrors?: string[];
}): Promise<EntryVerification> {
  const version = await verifyLatestVersion(options);
  if (!version.ok) return { ok: false, issues: version.issues };
  const proof = proveEntry(version.content, options.entryId);
  if (proof === undefined) {
    const revoked = version.log.some((manifest) => manifest.revoked.includes(options.entryId));
    return {
      ok: false,
      issues: [
        {
          path: options.entryId,
          message: revoked
            ? `Entry was revoked by its publisher`
            : `No such entry in version ${version.manifest.n}`,
          hint: `Version ${version.manifest.n} holds: ${version.content.entries.map((entry) => entry.id).join(', ')}.`,
        },
      ],
    };
  }
  // The proof is rebuilt from verified content, so this cannot fail here; it is what a light client runs.
  if (
    !verifyMerkleProof(
      Buffer.from(proof.leaf, 'hex'),
      proof.proof,
      Buffer.from(version.manifest.merkle_root, 'hex'),
    )
  ) {
    return {
      ok: false,
      issues: [
        {
          path: options.entryId,
          message: 'Merkle proof does not lead to the signed root',
          hint: 'Report this: it is a bug.',
        },
      ],
    };
  }
  return {
    ok: true,
    manifest: version.manifest,
    versions: version.log.length,
    contentSource: version.contentSource,
    proof,
  };
}

export type PublishResult =
  | { ok: true; published: true; dryRun: boolean; manifest: Manifest; files: string[] }
  | { ok: true; published: false; manifest: Manifest }
  | { ok: false; issues: Issue[] };

/**
 * Builds, signs and writes the next version of the log from the entries on disk. The existing log is
 * verified first: a publisher never extends a log it cannot itself verify.
 */
export async function publishVersion(options: {
  entriesDir: string;
  versionsDir: string;
  keyFile: string;
  uri: string;
  published: string;
  revoke?: string[];
  dryRun?: boolean;
}): Promise<PublishResult> {
  const registry = validatePath(options.entriesDir);
  if (!registry.ok) {
    const issues = registry.files.flatMap((file) =>
      file.issues.map((issue) => ({ ...issue, path: `${file.file}: ${issue.path}` })),
    );
    return { ok: false, issues: [...issues, ...registry.registryIssues] };
  }
  const entries = registry.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
  const key = await loadPublisherKey(options.keyFile);

  let previous: { manifest: Manifest; entries: Entry[] } | undefined;
  if (readRawLog(options.versionsDir).length > 0) {
    const latest = await verifyLatestVersion({
      versionsDir: options.versionsDir,
      trustedPublishers: [key.address],
    });
    if (!latest.ok)
      return {
        ok: false,
        issues: latest.issues.map((issue) => ({ ...issue, path: `existing log, ${issue.path}` })),
      };
    previous = { manifest: latest.manifest, entries: latest.content.entries };
  }

  const built = buildVersion({
    entries,
    publisher: key.address,
    uri: options.uri,
    published: options.published,
    ...(previous === undefined ? {} : { previous }),
    ...(options.revoke === undefined ? {} : { revoke: options.revoke }),
  });
  if (!built.ok) return built;
  if (built.unchanged) return { ok: true, published: false, manifest: built.manifest };

  const manifest = await signManifest(built.manifest, key.privateKey);
  const files = [
    contentFile(options.versionsDir, manifest.merkle_root),
    manifestFile(options.versionsDir, manifest.n),
  ];
  if (options.dryRun !== true) {
    mkdirSync(options.versionsDir, { recursive: true });
    writeFileSync(files[0] as string, built.content.bytes);
    // The manifest goes last: a log never names content that is not there.
    writeFileSync(files[1] as string, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { ok: true, published: true, dryRun: options.dryRun === true, manifest, files };
}
