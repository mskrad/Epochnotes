import { createHash } from 'node:crypto';

import * as vre from 'verifiable-outcome-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildMerkleLevels,
  buildMerkleProof,
  merkleRoot,
  rootFromProof,
  verifyMerkleProof,
} from '../src/index.js';

const leaf = (seed: number) => createHash('sha256').update(`leaf-${seed}`).digest();
const leavesOf = (count: number) => Array.from({ length: count }, (_, index) => leaf(index));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('merkle tree', () => {
  it.each([1, 2, 3, 4, 5, 8, 9, 17])('matches the VRE SDK byte for byte with %i leaves', (count) => {
    const leaves = leavesOf(count);
    const ours = buildMerkleLevels(leaves);
    const theirs = vre.buildMerkleLevels(leaves);
    expect(ours.map((level) => level.map(hex))).toEqual(theirs.map((level) => level.map(hex)));
    for (let index = 0; index < count; index += 1) {
      expect(buildMerkleProof(ours, index)).toEqual(vre.buildMerkleProof(theirs, index));
    }
  });

  it('proves every leaf and nothing else', () => {
    const leaves = leavesOf(7);
    const levels = buildMerkleLevels(leaves);
    const root = merkleRoot(levels);
    leaves.forEach((item, index) => {
      const proof = buildMerkleProof(levels, index);
      expect(verifyMerkleProof(item, proof, root)).toBe(true);
      expect(verifyMerkleProof(leaf(99), proof, root)).toBe(false);
      expect(verifyMerkleProof(item, proof, leaf(100))).toBe(false);
    });
  });

  it('rejects a proof with a flipped side, a changed sibling or a malformed step', () => {
    const leaves = leavesOf(4);
    const levels = buildMerkleLevels(leaves);
    const root = merkleRoot(levels);
    const target = leaves[1] as Buffer;
    const proof = buildMerkleProof(levels, 1);
    const [first, ...rest] = proof as [MerkleProofNode, ...MerkleProofNode[]];
    expect(verifyMerkleProof(target, [{ ...first, position: 'right' }, ...rest], root)).toBe(false);
    expect(verifyMerkleProof(target, [{ ...first, sibling: hex(leaf(50)) }, ...rest], root)).toBe(false);
    expect(verifyMerkleProof(target, [{ ...first, sibling: 'zz' }], root)).toBe(false);
    expect(() => rootFromProof(new Uint8Array(31), proof)).toThrow('31 bytes');
  });

  it('has the known ambiguity of self-paired odd nodes, which callers must bound', () => {
    const [a, b, c] = leavesOf(3) as [Buffer, Buffer, Buffer];
    // Same root for [a, b, c] and [a, b, c, c]: this is why a manifest states its entry count and content
    // refuses a repeated entry (see version.test.ts).
    expect(hex(merkleRoot(buildMerkleLevels([a, b, c])))).toBe(
      hex(merkleRoot(buildMerkleLevels([a, b, c, c]))),
    );
  });

  it('refuses an empty tree, a leaf of the wrong size and an index out of bounds', () => {
    expect(() => buildMerkleLevels([])).toThrow('at least one leaf');
    expect(() => buildMerkleLevels([new Uint8Array(20)])).toThrow('20 bytes');
    expect(() => buildMerkleProof(buildMerkleLevels(leavesOf(2)), 2)).toThrow(RangeError);
  });
});
