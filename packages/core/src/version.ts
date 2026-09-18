import { createHash, type webcrypto } from 'node:crypto';

import {
  getPublicKeyFromAddress,
  isAddress,
  signBytes,
  verifySignature,
  type SignatureBytes,
} from '@solana/kit';
import { z } from 'zod';

import { canonicalize, entryLeafHash, toHex } from './canonical.js';
import { buildMerkleLevels, buildMerkleProof, type MerkleProofNode, merkleRoot } from './merkle.js';
import type { Entry } from './schema.js';
import { type Issue, validateEntry, validateRegistry } from './validate.js';

export const MANIFEST_VERSION = 1;
/** `prev_root` of a publisher's first version: there is nothing before it. */
export const GENESIS_ROOT = '0'.repeat(64);
/** Prefix of the signed bytes, so a manifest signature can never be replayed as another kind of message. */
const SIGNING_DOMAIN = 'epochnotes/registry-version/v1\n';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * One version of a publisher's registry: the Merkle root over all entries, linked to the version before.
 * A publisher's log is linear and append-only; anything that changes produces the next version.
 */
export const manifestSchema = z.strictObject({
  manifest_version: z.literal(MANIFEST_VERSION),
  /** The publisher's ed25519 public key, as a Solana address. */
  publisher: z.string().refine((value): boolean => isAddress(value), 'must be a base58 ed25519 public key'),
  n: z.int().min(1),
  merkle_root: hex32,
  prev_root: hex32,
  entry_count: z.int().min(1),
  /** sha256 of the content file: one canonical entry per line, ordered by id. */
  content_hash: hex32,
  uri: z.string().min(1),
  published: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Ids present in the previous version and deliberately absent from this one. */
  revoked: z.array(z.string()).default([]),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type UnsignedManifest = Omit<Manifest, 'signature'>;

export interface VersionContent {
  bytes: Uint8Array;
  entries: Entry[];
  leaves: Uint8Array[];
}

const byId = (a: Entry, b: Entry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The content file of a version: canonical entries, one per line, ordered by id. */
export function encodeContent(entries: Entry[]): VersionContent {
  const ordered = [...entries].sort(byId);
  const text = ordered.map((entry) => `${canonicalize(entry)}\n`).join('');
  return { bytes: new TextEncoder().encode(text), entries: ordered, leaves: ordered.map(entryLeafHash) };
}

/**
 * Parses a content file strictly: every line must be a valid entry in exactly its canonical form, and
 * ids must ascend — so one set of entries has one possible file, and one possible root.
 */
export function decodeContent(
  bytes: Uint8Array,
): { ok: true; content: VersionContent } | { ok: false; issues: Issue[] } {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const lines = text.split('\n');
  if (lines.pop() !== '')
    return {
      ok: false,
      issues: [
        {
          path: 'content',
          message: 'Content must end with a newline',
          hint: 'The file is truncated or was edited.',
        },
      ],
    };
  const entries: Entry[] = [];
  const issues: Issue[] = [];
  lines.forEach((line, index) => {
    const at = `content line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      issues.push({
        path: at,
        message: 'Not JSON',
        hint: 'The content file was edited or is not a registry version.',
      });
      return;
    }
    const result = validateEntry(raw);
    if (!result.ok) {
      issues.push(...result.issues.map((issue) => ({ ...issue, path: `${at}: ${issue.path}` })));
      return;
    }
    if (canonicalize(result.entry) !== line) {
      issues.push({
        path: at,
        message: 'Entry is not in canonical form',
        hint: 'Content files are written by `registry publish`, never by hand.',
      });
      return;
    }
    const previous = entries[entries.length - 1];
    if (previous !== undefined && previous.id >= result.entry.id) {
      issues.push({
        path: at,
        message: `Entry "${result.entry.id}" is out of order or repeated`,
        hint: 'Entries are ordered by id and unique.',
      });
      return;
    }
    entries.push(result.entry);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, content: { bytes, entries, leaves: entries.map(entryLeafHash) } };
}

/** What an edit between two versions is allowed to look like. */
function revisionIssues(previous: Entry[], next: Entry[], revoke: string[]): Issue[] {
  const issues: Issue[] = [];
  const before = new Map(previous.map((entry) => [entry.id, entry]));
  const after = new Map(next.map((entry) => [entry.id, entry]));
  for (const entry of next) {
    const old = before.get(entry.id);
    if (old === undefined) {
      if (entry.rev !== 1)
        issues.push({
          path: entry.id,
          message: `New entry starts at rev ${entry.rev}`,
          hint: 'A new entry starts at rev 1.',
        });
      continue;
    }
    // rev is part of the content, so any difference — a bare rev change included — shows up in the leaf.
    const changed = toHex(entryLeafHash(old)) !== toHex(entryLeafHash(entry));
    if (changed && entry.rev !== old.rev + 1) {
      issues.push({
        path: entry.id,
        message: `Content changed but rev is ${entry.rev}, published rev is ${old.rev}`,
        hint: `Set rev to ${old.rev + 1}: every edit of a published entry is a new revision.`,
      });
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id) && !revoke.includes(id)) {
      issues.push({
        path: id,
        message: 'Published entry is missing from the registry',
        hint: `Restore it, or revoke it on purpose with --revoke ${id}.`,
      });
    }
  }
  for (const id of revoke) {
    if (!before.has(id))
      issues.push({
        path: id,
        message: 'Cannot revoke an entry that is not in the previous version',
        hint: 'Check the id.',
      });
    else if (after.has(id))
      issues.push({
        path: id,
        message: 'Entry is both revoked and still present',
        hint: 'Remove the entry file, or drop --revoke.',
      });
  }
  return issues;
}

export interface PreviousVersion {
  manifest: Manifest;
  entries: Entry[];
}

export type BuildResult =
  | { ok: true; unchanged: false; manifest: UnsignedManifest; content: VersionContent }
  | { ok: true; unchanged: true; manifest: Manifest }
  | { ok: false; issues: Issue[] };

/** The next version of a publisher's log, or the reasons it cannot be built. */
export function buildVersion(options: {
  entries: Entry[];
  previous?: PreviousVersion;
  publisher: string;
  /** Where the content will be served; `{root}` is replaced by the Merkle root. */
  uri: string;
  published: string;
  revoke?: string[];
}): BuildResult {
  const revoke = options.revoke ?? [];
  if (options.entries.length === 0)
    return {
      ok: false,
      issues: [
        { path: 'registry', message: 'No entries to publish', hint: 'A version holds at least one entry.' },
      ],
    };
  const issues = [
    ...validateRegistry(options.entries),
    ...revisionIssues(options.previous?.entries ?? [], options.entries, revoke),
  ];
  if (options.previous !== undefined && options.previous.manifest.publisher !== options.publisher) {
    issues.push({
      path: 'publisher',
      message: `The log belongs to ${options.previous.manifest.publisher}`,
      hint: 'A log has one publisher; sign with its key.',
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  const content = encodeContent(options.entries);
  const root = toHex(merkleRoot(buildMerkleLevels(content.leaves)));
  if (options.previous !== undefined && options.previous.manifest.merkle_root === root) {
    return { ok: true, unchanged: true, manifest: options.previous.manifest };
  }
  const manifest: UnsignedManifest = {
    manifest_version: MANIFEST_VERSION,
    publisher: options.publisher,
    n: (options.previous?.manifest.n ?? 0) + 1,
    merkle_root: root,
    prev_root: options.previous?.manifest.merkle_root ?? GENESIS_ROOT,
    entry_count: content.entries.length,
    content_hash: sha256Hex(content.bytes),
    uri: options.uri.replaceAll('{root}', root),
    published: options.published,
    revoked: [...revoke].sort(),
  };
  return { ok: true, unchanged: false, manifest, content };
}

/** The exact bytes a publisher signs: a domain prefix, then the canonical manifest without its signature. */
export function manifestSigningBytes(manifest: UnsignedManifest | Manifest): Uint8Array {
  const unsigned: Record<string, unknown> = { ...manifest };
  delete unsigned.signature;
  return new TextEncoder().encode(SIGNING_DOMAIN + canonicalize(unsigned));
}

export async function signManifest(
  manifest: UnsignedManifest,
  privateKey: webcrypto.CryptoKey,
): Promise<Manifest> {
  return { ...manifest, signature: toHex(await signBytes(privateKey, manifestSigningBytes(manifest))) };
}

export async function verifyManifestSignature(manifest: Manifest): Promise<boolean> {
  try {
    const key = await getPublicKeyFromAddress(
      manifest.publisher as Parameters<typeof getPublicKeyFromAddress>[0],
    );
    const signature = Uint8Array.from(Buffer.from(manifest.signature, 'hex')) as SignatureBytes;
    return await verifySignature(key, signature, manifestSigningBytes(manifest));
  } catch {
    return false;
  }
}

/**
 * Checks a publisher's whole log: every manifest well-formed and signed by one trusted publisher,
 * numbered from 1 without gaps, each `prev_root` equal to the root before it.
 */
export async function verifyLog(
  rawManifests: unknown[],
  trustedPublishers: string[],
): Promise<{ ok: true; manifests: Manifest[] } | { ok: false; issues: Issue[] }> {
  const issues: Issue[] = [];
  const manifests: Manifest[] = [];
  for (const [index, raw] of rawManifests.entries()) {
    const at = `version ${index + 1}`;
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(
        ...parsed.error.issues.map((issue) => ({
          path: `${at}: ${issue.path.join('.')}`,
          message: issue.message,
          hint: 'The manifest is malformed; fetch the log again from its publisher.',
        })),
      );
      continue;
    }
    const manifest = parsed.data;
    const before = manifests[manifests.length - 1];
    if (manifest.n !== index + 1)
      issues.push({
        path: at,
        message: `Manifest is numbered ${manifest.n}`,
        hint: 'A log is numbered from 1 without gaps; a version is missing or out of place.',
      });
    if (!trustedPublishers.includes(manifest.publisher))
      issues.push({
        path: at,
        message: `Publisher ${manifest.publisher} is not trusted`,
        hint: 'Add the publisher to registry/publishers.json only if you trust it.',
      });
    if (before !== undefined && before.publisher !== manifest.publisher)
      issues.push({
        path: at,
        message: 'Publisher changes within one log',
        hint: 'Each publisher has its own log.',
      });
    const expectedPrev = before?.merkle_root ?? GENESIS_ROOT;
    if (manifest.prev_root !== expectedPrev)
      issues.push({
        path: at,
        message: `prev_root ${manifest.prev_root.slice(0, 16)}... does not continue ${expectedPrev.slice(0, 16)}...`,
        hint: 'The chain of versions is broken: a version was removed, replaced or reordered.',
      });
    if (!(await verifyManifestSignature(manifest)))
      issues.push({
        path: at,
        message: 'Signature does not match the manifest and its publisher',
        hint: 'The manifest was altered after signing, or was signed by another key.',
      });
    manifests.push(manifest);
  }
  if (rawManifests.length === 0)
    issues.push({ path: 'log', message: 'The log is empty', hint: 'Nothing has been published yet.' });
  return issues.length === 0 ? { ok: true, manifests } : { ok: false, issues };
}

/** Checks served content against a verified manifest: bytes, entry count and Merkle root. */
export function verifyContent(
  manifest: Manifest,
  bytes: Uint8Array,
): { ok: true; content: VersionContent } | { ok: false; issues: Issue[] } {
  const hash = sha256Hex(bytes);
  if (hash !== manifest.content_hash)
    return {
      ok: false,
      issues: [
        {
          path: `version ${manifest.n}`,
          message: `Content hashes to ${hash.slice(0, 16)}..., manifest commits to ${manifest.content_hash.slice(0, 16)}...`,
          hint: 'The content was altered or belongs to another version.',
        },
      ],
    };
  const decoded = decodeContent(bytes);
  if (!decoded.ok) return decoded;
  const issues: Issue[] = [];
  if (decoded.content.entries.length !== manifest.entry_count)
    issues.push({
      path: `version ${manifest.n}`,
      message: `Content has ${decoded.content.entries.length} entries, manifest states ${manifest.entry_count}`,
      hint: 'The manifest and the content do not belong together.',
    });
  const root = toHex(merkleRoot(buildMerkleLevels(decoded.content.leaves)));
  if (root !== manifest.merkle_root)
    issues.push({
      path: `version ${manifest.n}`,
      message: `Entries give root ${root.slice(0, 16)}..., manifest states ${manifest.merkle_root.slice(0, 16)}...`,
      hint: 'The manifest and the content do not belong together.',
    });
  return issues.length === 0 ? decoded : { ok: false, issues };
}

export interface EntryProof {
  entry: Entry;
  leaf: string;
  index: number;
  proof: MerkleProofNode[];
}

/** The proof that one entry belongs to a version's content, or undefined when the id is not in it. */
export function proveEntry(content: VersionContent, id: string): EntryProof | undefined {
  const index = content.entries.findIndex((entry) => entry.id === id);
  const entry = content.entries[index];
  const leaf = content.leaves[index];
  if (entry === undefined || leaf === undefined) return undefined;
  return {
    entry,
    leaf: toHex(leaf),
    index,
    proof: buildMerkleProof(buildMerkleLevels(content.leaves), index),
  };
}
