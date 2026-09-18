/*
 * Merkle tree over 32-byte leaves. `buildMerkleLevels` and `buildMerkleProof` are ported from the
 * Verifiable Outcome Engine SDK (MIT, github.com/mskrad/verifiable-outcome-engine, sdk/snapshot.ts at
 * commit 3f24f675d029), whose pair-hash scheme is `sha256_pair_v1`: a parent is sha256(left || right) and an
 * odd node is paired with itself. A test keeps this port byte-for-byte compatible with that SDK.
 *
 * Folding a proof back into a root is written here, because the SDK's own verifier is bound to its
 * snapshot line format.
 */
import { createHash } from 'node:crypto';

export interface MerkleProofNode {
  /** The side the sibling sits on. */
  position: 'left' | 'right';
  /** The sibling hash, 32 bytes as hex. */
  sibling: string;
}

const HASH_BYTES = 32;

function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

function pair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(HASH_BYTES * 2);
  joined.set(left, 0);
  joined.set(right, HASH_BYTES);
  return sha256(joined);
}

export function buildMerkleLevels(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error('A Merkle tree needs at least one leaf');
  leaves.forEach((leaf, index) => {
    if (leaf.length !== HASH_BYTES)
      throw new Error(`Leaf ${index} is ${leaf.length} bytes, expected ${HASH_BYTES}`);
  });
  const levels: Uint8Array[][] = [leaves.map((leaf) => Uint8Array.from(leaf))];
  for (let level = levels[0] ?? []; level.length > 1; level = levels[levels.length - 1] ?? []) {
    const next: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] as Uint8Array;
      next.push(pair(left, level[index + 1] ?? left));
    }
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(levels: Uint8Array[][]): Uint8Array {
  return levels[levels.length - 1]?.[0] as Uint8Array;
}

export function buildMerkleProof(levels: Uint8Array[][], leafIndex: number): MerkleProofNode[] {
  const leafCount = levels[0]?.length ?? 0;
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafCount) {
    throw new RangeError(`Leaf index ${leafIndex} is out of bounds for ${leafCount} leaves`);
  }
  const proof: MerkleProofNode[] = [];
  let index = leafIndex;
  for (const level of levels.slice(0, -1)) {
    const isRight = index % 2 === 1;
    const sibling = level[isRight ? index - 1 : index + 1] ?? (level[index] as Uint8Array);
    proof.push({ position: isRight ? 'left' : 'right', sibling: Buffer.from(sibling).toString('hex') });
    index = Math.floor(index / 2);
  }
  return proof;
}

/** Folds a leaf and its proof (leaf upward) into the root they imply. */
export function rootFromProof(leaf: Uint8Array, proof: MerkleProofNode[]): Uint8Array {
  if (leaf.length !== HASH_BYTES) throw new Error(`Leaf is ${leaf.length} bytes, expected ${HASH_BYTES}`);
  return proof.reduce<Uint8Array>((node, step, index) => {
    if ((step.position !== 'left' && step.position !== 'right') || !/^[0-9a-f]{64}$/.test(step.sibling)) {
      throw new TypeError(
        `proof[${index}] must be { position: "left" | "right", sibling: 32-byte lowercase hex }`,
      );
    }
    const sibling = Buffer.from(step.sibling, 'hex');
    return step.position === 'left' ? pair(sibling, node) : pair(node, sibling);
  }, Uint8Array.from(leaf));
}

/**
 * True when the leaf belongs to the tree with this root. A malformed proof is simply not a proof.
 * The scheme has no leaf/node domain separation, so callers must also bound the tree: a version
 * manifest states its entry count, and a registry rejects duplicate entries, which rules out the
 * "repeat the last leaf" ambiguity of self-paired odd nodes.
 */
export function verifyMerkleProof(leaf: Uint8Array, proof: MerkleProofNode[], root: Uint8Array): boolean {
  try {
    return Buffer.from(rootFromProof(leaf, proof)).equals(Buffer.from(root));
  } catch {
    return false;
  }
}
