import { randomUUID, type webcrypto } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { createKeyPairFromBytes, getAddressFromPublicKey } from '@solana/kit';

import { type ContentAttempt, ContentUnavailableError, fetchCommittedContent } from './content-source.js';
import { validatePath } from './load.js';
import { verifyMerkleProof } from './merkle.js';
import type { Issue } from './validate.js';
import {
  buildVersion,
  type EntryProof,
  type Manifest,
  pinIssues,
  type PreviousVersion,
  proveEntry,
  revocationIssues,
  revokedIds,
  signManifest,
  verifyContent,
  verifyLog,
  type VersionContent,
  type VersionPin,
} from './version.js';

/** Layout of a versions directory: `<n>.json` manifests and `<merkle_root>.jsonl` content files. */
const manifestFile = (dir: string, n: number) => join(dir, `${n}.json`);
const contentFile = (dir: string, root: string) => join(dir, `${root}.jsonl`);

export function readRawLog(versionsDir: string): unknown[] {
  if (!existsSync(versionsDir)) return [];
  return readdirSync(versionsDir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(versionsDir, name), 'utf8')) as unknown;
      } catch {
        // Left for `verifyLog` to report as a malformed manifest: garbage from a server is a finding, not a crash.
        return undefined;
      }
    });
}

export function readTrustedPublishers(file: string): string[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    publishers?: { key?: unknown; status?: unknown }[];
  };
  return (parsed.publishers ?? [])
    .filter((publisher) => publisher.status === 'active' && typeof publisher.key === 'string')
    .map((publisher) => publisher.key as string);
}

type PrivateKey = webcrypto.CryptoKey;

/** A publisher key in the format `solana-keygen` writes: a JSON array of the 64 secret-key bytes. */
export async function loadPublisherKey(
  keyFile: string,
): Promise<{ address: string; privateKey: PrivateKey }> {
  const text = readFileSync(keyFile, 'utf8');
  try {
    const pair = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(text) as number[]));
    return { address: await getAddressFromPublicKey(pair.publicKey), privateKey: pair.privateKey };
  } catch {
    // Says nothing about the contents on purpose: parser errors quote their input, and this input is a secret.
    throw new Error(`${keyFile} is not a keypair in solana-keygen format (a JSON array of 64 bytes)`);
  }
}

export type VerifiedVersion =
  | { ok: true; manifest: Manifest; log: Manifest[]; content: VersionContent; contentSource: string }
  | { ok: false; issues: Issue[]; attempts?: ContentAttempt[] };

export interface VerifyOptions {
  versionsDir: string;
  trustedPublishers: string[];
  mirrors?: string[];
  /** The version seen last time; without it a rolled-back or rewritten log cannot be told from a current one. */
  pin?: VersionPin;
}

/**
 * Verifies a publisher's log and the content of its latest version without trusting the server:
 * signatures and the prev_root chain, the remembered version if any, then the content against the hash
 * and root it commits to, then the rule that only the whole log can show: a revoked id never returns.
 */
export async function verifyLatestVersion(options: VerifyOptions): Promise<VerifiedVersion> {
  const log = await verifyLog(readRawLog(options.versionsDir), options.trustedPublishers);
  if (!log.ok) return log;
  if (options.pin !== undefined) {
    const rollback = pinIssues(log.manifests, options.pin);
    if (rollback.length > 0) return { ok: false, issues: rollback };
  }
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
    const reused = revocationIssues(log.manifests, content.content);
    if (reused.length > 0) return { ok: false, issues: reused };
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
export async function verifyEntry(options: VerifyOptions & { entryId: string }): Promise<EntryVerification> {
  const version = await verifyLatestVersion(options);
  if (!version.ok) return { ok: false, issues: version.issues };
  const proof = proveEntry(version.content, options.entryId);
  if (proof === undefined) {
    const revoked = revokedIds(version.log).includes(options.entryId);
    return {
      ok: false,
      issues: [
        {
          path: options.entryId,
          message: revoked
            ? 'Entry was revoked by its publisher'
            : `No such entry in version ${version.manifest.n}`,
          hint: `Version ${version.manifest.n} holds: ${version.content.entries.map((entry) => entry.id).join(', ')}.`,
        },
      ],
    };
  }
  // The same bounded check a light client runs with only the entry, its proof and the signed manifest.
  const bounded = verifyMerkleProof({
    leaf: Buffer.from(proof.leaf, 'hex'),
    index: proof.index,
    leafCount: version.manifest.entry_count,
    proof: proof.proof,
    root: Buffer.from(version.manifest.merkle_root, 'hex'),
  });
  if (!bounded) {
    const issue = {
      path: options.entryId,
      message: 'Merkle proof does not lead to the signed root',
      hint: 'Report this: it is a bug.',
    };
    return { ok: false, issues: [issue] };
  }
  return {
    ok: true,
    manifest: version.manifest,
    versions: version.log.length,
    contentSource: version.contentSource,
    proof,
  };
}

/**
 * Creates `target` with `text`, whole or not at all, and only if it does not exist yet. The text is staged
 * under a private name and then hard-linked into place: unlike rename, link fails when the target exists,
 * so the check and the creation are one atomic step.
 */
export function writeNewFile(target: string, text: string): void {
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staged, text, { flag: 'wx' });
  try {
    linkSync(staged, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${target} already exists: another publish got there first`);
    }
    throw error;
  } finally {
    unlinkSync(staged);
  }
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

  const rawLog = readRawLog(options.versionsDir);
  const owner = (rawLog[0] as { publisher?: unknown } | undefined)?.publisher;
  if (typeof owner === 'string' && owner !== key.address) {
    const hint = 'A log has one publisher: sign with its key, or publish into another versions directory.';
    return {
      ok: false,
      issues: [
        { path: 'publisher', message: `The log belongs to ${owner}, but the key is ${key.address}`, hint },
      ],
    };
  }
  let previous: PreviousVersion | undefined;
  if (rawLog.length > 0) {
    const latest = await verifyLatestVersion({
      versionsDir: options.versionsDir,
      trustedPublishers: [key.address],
    });
    if (!latest.ok) {
      return {
        ok: false,
        issues: latest.issues.map((issue) => ({ ...issue, path: `existing log, ${issue.path}` })),
      };
    }
    previous = {
      manifest: latest.manifest,
      entries: latest.content.entries,
      revokedBefore: revokedIds(latest.log),
    };
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
  const target = manifestFile(options.versionsDir, manifest.n);
  const files = [contentFile(options.versionsDir, manifest.merkle_root), target];
  if (options.dryRun !== true) {
    mkdirSync(options.versionsDir, { recursive: true });
    writeFileSync(files[0] as string, built.content.bytes);
    // The manifest goes last and never over an existing version: a log never names content that is not
    // there, and of two publishes racing for one number exactly one wins.
    writeNewFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { ok: true, published: true, dryRun: options.dryRun === true, manifest, files };
}
