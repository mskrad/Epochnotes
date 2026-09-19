import { randomUUID, type webcrypto } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  manifestSchema,
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

const isUrl = (location: string) => /^https?:\/\//i.test(location);
const MAX_REMOTE_VERSIONS = 10_000;
const MANIFEST_TIMEOUT_MS = 20_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const REMOTE_LOG_DEADLINE_MS = 120_000;

/**
 * Reads a publisher's log from a directory or from a static web host laid out the same way
 * (`<base>/1.json`, `<base>/2.json`, ...). Over HTTP the log ends at the first 404. Nothing read here is
 * trusted: `verifyLog` checks every manifest, and a server that stops early is what `--pin` and
 * `--onchain` are for.
 */
export async function readRawLogFrom(location: string): Promise<unknown[]> {
  if (!isUrl(location)) return readRawLog(location);
  const base = location.replace(/\/+$/, '');
  const deadline = Date.now() + REMOTE_LOG_DEADLINE_MS;
  const log: unknown[] = [];
  for (let n = 1; n <= MAX_REMOTE_VERSIONS; n += 1) {
    if (Date.now() > deadline)
      throw new Error(`${base} did not serve its log within ${REMOTE_LOG_DEADLINE_MS / 1000} s`);
    const response = await fetch(`${base}/${n}.json`, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (response.status === 404) return log;
    if (!response.ok) throw new Error(`${base}/${n}.json answered HTTP ${response.status}`);
    const manifest = await readBoundedJson(response);
    log.push(manifest);
    // Anything that is not a manifest ends the reading: a host that answers 200 to every path, with a page or
    // with `{}`, must not be followed for ten thousand requests. `verifyLog` reports the bad item as a finding.
    if (!manifestSchema.safeParse(manifest).success) return log;
  }
  throw new Error(`${base} serves more than ${MAX_REMOTE_VERSIONS} versions; refusing to go on`);
}

/** The body as JSON, or undefined when it is too large or not JSON. The size is checked while reading. */
async function readBoundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_MANIFEST_BYTES) {
    await response.body?.cancel();
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > MAX_MANIFEST_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
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
  /** A directory, or the base URL of a static host with the same layout. */
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
  // A path that does not exist is a mistake in the environment, not a log that failed verification.
  if (!isUrl(options.versionsDir) && !existsSync(options.versionsDir))
    throw new Error(`there is no version log at "${options.versionsDir}"`);
  const log = await verifyLog(await readRawLogFrom(options.versionsDir), options.trustedPublishers);
  if (!log.ok) return log;
  if (options.pin !== undefined) {
    const rollback = pinIssues(log.manifests, options.pin);
    if (rollback.length > 0) return { ok: false, issues: rollback };
  }
  const manifest = log.manifests[log.manifests.length - 1] as Manifest;
  // Content sits next to the manifests, in a directory and on a web host alike; it is accepted by hash only.
  const sibling = isUrl(options.versionsDir)
    ? `${options.versionsDir.replace(/\/+$/, '')}/${manifest.merkle_root}.jsonl`
    : contentFile(options.versionsDir, manifest.merkle_root);
  try {
    const fetched = await fetchCommittedContent({
      uri: manifest.uri,
      hash: manifest.content_hash,
      ...(isUrl(sibling) ? { alsoAt: [sibling] } : existsSync(sibling) ? { localFile: sibling } : {}),
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
  | {
      ok: true;
      manifest: Manifest;
      versions: number;
      contentSource: string;
      proof: EntryProof;
      log: Manifest[];
    }
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
    log: version.log,
  };
}

/**
 * Creates `target` with `text`, whole or not at all, and only if it does not exist yet. The text is staged
 * under a private name and then hard-linked into place: unlike rename, link fails when the target exists,
 * so the check and the creation are one atomic step.
 */
export function writeNewFile(target: string, text: string): void {
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, text, { flag: 'wx' });
    linkSync(staged, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error(`${target} already exists: another publish got there first`);
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EMLINK') {
      throw new Error(
        `Cannot create ${target}: this file system does not support hard links (${code}); publish on a local disk`,
      );
    }
    throw error;
  } finally {
    // Best effort: a staging file that cannot be removed must not hide the real outcome, and readers ignore it.
    rmSync(staged, { force: true });
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
