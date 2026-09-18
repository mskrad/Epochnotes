import { createHash } from 'node:crypto';

import * as vre from 'verifiable-outcome-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildMerkleLevels,
  buildMerkleProof,
  merkleDepth,
  type MerkleProofNode,
  merkleRoot,
  rootFromProof,
  verifyMerkleProof,
} from '../src/index.js';

const leaf = (seed: number) => createHash('sha256').update(`leaf-${seed}`).digest();
const leavesOf = (count: number) => Array.from({ length: count }, (_, index) => leaf(index));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const at = <T>(items: T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};

describe('compatibility with the VRE SDK', () => {
  it.each([1, 2, 3, 4, 5, 8, 9, 17])('builds the same levels and proofs with %i leaves', (count) => {
    const leaves = leavesOf(count);
    const ours = buildMerkleLevels(leaves);
    const theirs = vre.buildMerkleLevels(leaves);
    expect(ours.map((level) => level.map(hex))).toEqual(theirs.map((level) => level.map(hex)));
    for (let index = 0; index < count; index += 1) {
      expect(buildMerkleProof(ours, index)).toEqual(vre.buildMerkleProof(theirs, index));
    }
  });

  it.each([1, 2, 3, 6, 7])('each side verifies the proofs of the other, with %i leaves', (count) => {
    // VRE's verifier hashes a snapshot line itself, so the leaves here are made its way.
    const lines = Array.from({ length: count }, (_, index) => `{"id":"p${index}","order":${index}}\n`);
    const leaves = lines.map((line) => vre.hashSnapshotLeafLine(line));
    const ours = buildMerkleLevels(leaves);
    const theirs = vre.buildMerkleLevels(leaves);
    lines.forEach((line, index) => {
      // our proof and root, their verifier
      expect(
        vre.verifySnapshotMerkleProof({
          line,
          proof: buildMerkleProof(ours, index),
          merkleRoot: Buffer.from(merkleRoot(ours)),
        }),
      ).toBe(true);
      // their proof and root, our verifier
      const theirRoot = at(at(theirs, theirs.length - 1), 0);
      expect(
        verifyMerkleProof({
          leaf: at(leaves, index),
          index,
          leafCount: count,
          proof: vre.buildMerkleProof(theirs, index),
          root: theirRoot,
        }),
      ).toBe(true);
    });
    // and both reject a line that is not in the tree
    expect(
      vre.verifySnapshotMerkleProof({
        line: '{"id":"x"}\n',
        proof: buildMerkleProof(ours, 0),
        merkleRoot: Buffer.from(merkleRoot(ours)),
      }),
    ).toBe(false);
  });
});

describe('proof verification', () => {
  it.each([1, 2, 3, 5, 7, 8])(
    'accepts every leaf at its own index and nowhere else, with %i leaves',
    (count) => {
      const leaves = leavesOf(count);
      const levels = buildMerkleLevels(leaves);
      const root = merkleRoot(levels);
      leaves.forEach((item, index) => {
        const proof = buildMerkleProof(levels, index);
        expect(proof).toHaveLength(merkleDepth(count));
        expect(verifyMerkleProof({ leaf: item, index, leafCount: count, proof, root })).toBe(true);
        expect(verifyMerkleProof({ leaf: leaf(99), index, leafCount: count, proof, root })).toBe(false);
        expect(verifyMerkleProof({ leaf: item, index, leafCount: count, proof, root: leaf(100) })).toBe(
          false,
        );
        if (count > 1)
          expect(
            verifyMerkleProof({ leaf: item, index: (index + 1) % count, leafCount: count, proof, root }),
          ).toBe(false);
      });
    },
  );

  it('rejects an inner node presented as a leaf with a shorter proof', () => {
    const leaves = leavesOf(4);
    const levels = buildMerkleLevels(leaves);
    const root = merkleRoot(levels);
    const inner = at(at(levels, 1), 0);
    const shorter = buildMerkleProof(levels, 0).slice(1);
    // The unbounded fold does reach the root — which is exactly why the bounded check exists.
    expect(hex(rootFromProof(inner, shorter))).toBe(hex(root));
    expect(verifyMerkleProof({ leaf: inner, index: 0, leafCount: 4, proof: shorter, root })).toBe(false);
    expect(verifyMerkleProof({ leaf: inner, index: 0, leafCount: 2, proof: shorter, root })).toBe(true); // a different, 2-leaf tree
  });

  it('rejects the repeated last leaf of a self-paired odd node', () => {
    const [a, b, c] = leavesOf(3) as [Buffer, Buffer, Buffer];
    const padded = buildMerkleLevels([a, b, c, c]);
    const root = merkleRoot(buildMerkleLevels([a, b, c]));
    expect(hex(merkleRoot(padded))).toBe(hex(root)); // the ambiguity is real
    const ghost = buildMerkleProof(padded, 3);
    expect(verifyMerkleProof({ leaf: c, index: 3, leafCount: 3, proof: ghost, root })).toBe(false);
    expect(
      verifyMerkleProof({ leaf: c, index: 2, leafCount: 3, proof: buildMerkleProof(padded, 2), root }),
    ).toBe(true);
  });

  it('rejects a flipped side, a changed sibling, a malformed step and impossible counts', () => {
    const leaves = leavesOf(4);
    const levels = buildMerkleLevels(leaves);
    const root = merkleRoot(levels);
    const target = at(leaves, 1);
    const [first, ...rest] = buildMerkleProof(levels, 1) as [MerkleProofNode, ...MerkleProofNode[]];
    const check = (proof: MerkleProofNode[], leafCount = 4) =>
      verifyMerkleProof({ leaf: target, index: 1, leafCount, proof, root });
    expect(check([first, ...rest])).toBe(true);
    expect(check([{ ...first, position: 'right' }, ...rest])).toBe(false);
    expect(check([{ ...first, sibling: hex(leaf(50)) }, ...rest])).toBe(false);
    expect(check([{ ...first, sibling: 'zz' }, ...rest])).toBe(false);
    expect(check([first, ...rest], 0)).toBe(false);
    expect(check([first, ...rest], 1.5)).toBe(false);
    expect(() => rootFromProof(new Uint8Array(31), rest)).toThrow('31 bytes');
  });

  it('refuses an empty tree, a leaf of the wrong size and an index out of bounds', () => {
    expect(() => buildMerkleLevels([])).toThrow('at least one leaf');
    expect(() => buildMerkleLevels([new Uint8Array(20)])).toThrow('20 bytes');
    expect(() => buildMerkleProof(buildMerkleLevels(leavesOf(2)), 2)).toThrow(RangeError);
    expect([1, 2, 3, 4, 5, 8, 9].map(merkleDepth)).toEqual([0, 1, 2, 2, 3, 3, 4]);
  });
});
