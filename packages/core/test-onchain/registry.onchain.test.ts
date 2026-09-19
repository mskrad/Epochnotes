import {
  AccountRole,
  type Address,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  type Instruction,
  type KeyPairSigner,
  lamports,
} from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  compareLogWithChain,
  configAddress,
  fetchPublisher,
  fetchVersion,
  GENESIS_ROOT,
  initializeInstruction,
  loadSigner,
  type Manifest,
  type OnchainCluster,
  publishVersionInstruction,
  registerPublisherInstruction,
  revokeEntryInstruction,
  sendInstructions,
  type VersionArgs,
} from '../src/index.js';
import { sharedTestAdminKey } from '../test/keys.js';

const cluster: OnchainCluster = { rpcUrl: 'http://127.0.0.1:8899', wsUrl: 'ws://127.0.0.1:8900' };
const root = (byte: string) => byte.repeat(32);
const version = (n: bigint, merkleRoot: string, prevRoot: string): VersionArgs => ({
  n,
  merkleRoot,
  prevRoot,
  contentHash: root('cc'),
  entryCount: 4,
  uri: `https://example.test/versions/${merkleRoot}.jsonl`,
});

/** Anchor custom errors, in the order of `RegistryError`. */
const ERROR = {
  NotAdmin: 6000,
  NotPublisher: 6001,
  PublisherNotActive: 6002,
  VersionOutOfOrder: 6003,
  BrokenChain: 6004,
  InvalidEntryId: 6008,
} as const;

async function failure(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (error === undefined) throw new Error('expected the transaction to fail');
  const seen: unknown[] = [];
  for (
    let at: unknown = error;
    at !== undefined && at !== null && seen.length < 6;
    at = (at as { cause?: unknown }).cause
  )
    seen.push(at);
  return seen
    .map(
      (item) =>
        `${String(item)} ${JSON.stringify((item as { context?: unknown }).context, (_key, value) => (typeof value === 'bigint' ? Number(value) : value))}`,
    )
    .join(' | ');
}

let admin: KeyPairSigner;
let publisher: KeyPairSigner;
let outsider: KeyPairSigner;

beforeAll(async () => {
  const rpc = createSolanaRpc(cluster.rpcUrl);
  const airdrop = airdropFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(cluster.wsUrl) });
  // The registry config is a singleton: every on-chain suite acts as the same admin.
  admin = await loadSigner(sharedTestAdminKey());
  [publisher, outsider] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  for (const signer of [admin, publisher, outsider]) {
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(2_000_000_000n),
      commitment: 'confirmed',
    });
  }
  const config = await rpc.getAccountInfo(await configAddress(), { encoding: 'base64' }).send();
  if (config.value === null) {
    await sendInstructions(cluster, admin, [await initializeInstruction(admin.address)]);
  }
  await sendInstructions(cluster, admin, [
    await registerPublisherInstruction(admin.address, publisher.address, 'Epochnotes test'),
  ]);
});

describe('registry program', () => {
  it('admits a publisher with an empty log', async () => {
    expect(await fetchPublisher(cluster, publisher.address)).toMatchObject({
      authority: publisher.address,
      name: 'Epochnotes test',
      active: true,
      admittedBy: admin.address,
      versionCount: 0n,
      latestRoot: GENESIS_ROOT,
    });
  });

  it('refuses a publisher admitted by anyone but the admin', async () => {
    const attempt = sendInstructions(cluster, outsider, [
      await registerPublisherInstruction(outsider.address, outsider.address, 'self-admitted'),
    ]);
    expect(await failure(attempt)).toContain(String(ERROR.NotAdmin));
  });

  it('appends versions that continue the chain', async () => {
    const first = await sendInstructions(cluster, publisher, [
      await publishVersionInstruction(publisher.address, version(1n, root('a1'), GENESIS_ROOT)),
    ]);
    expect(first).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    await sendInstructions(cluster, publisher, [
      await publishVersionInstruction(publisher.address, version(2n, root('a2'), root('a1'))),
    ]);
    expect(await fetchPublisher(cluster, publisher.address)).toMatchObject({
      versionCount: 2n,
      latestRoot: root('a2'),
    });
    expect(await fetchVersion(cluster, publisher.address, 2n)).toMatchObject({
      n: 2n,
      merkleRoot: root('a2'),
      prevRoot: root('a1'),
      entryCount: 4,
    });
  });

  it('refuses a version whose prev_root does not continue the chain', async () => {
    const attempt = sendInstructions(cluster, publisher, [
      await publishVersionInstruction(publisher.address, version(3n, root('a3'), root('ff'))),
    ]);
    expect(await failure(attempt)).toContain(String(ERROR.BrokenChain));
  });

  it('refuses a repeated and a skipped version number', async () => {
    const repeated = sendInstructions(cluster, publisher, [
      await publishVersionInstruction(publisher.address, version(2n, root('b2'), root('a2'))),
    ]);
    expect(await failure(repeated)).not.toBe('');
    const skipped = sendInstructions(cluster, publisher, [
      await publishVersionInstruction(publisher.address, version(4n, root('a4'), root('a2'))),
    ]);
    expect(await failure(skipped)).toContain(String(ERROR.VersionOutOfOrder));
    expect(await fetchPublisher(cluster, publisher.address)).toMatchObject({
      versionCount: 2n,
      latestRoot: root('a2'),
    });
  });

  it('refuses a version signed by someone who is not the publisher', async () => {
    // The outsider aims at the publisher's log: same accounts, but signs with its own key.
    const honest = await publishVersionInstruction(publisher.address, version(3n, root('e3'), root('a2')));
    const accounts = (honest.accounts ?? []).map((account) =>
      account.role === AccountRole.WRITABLE_SIGNER
        ? { address: outsider.address as Address, role: AccountRole.WRITABLE_SIGNER }
        : account,
    );
    const forged = { ...honest, accounts } as Instruction;
    expect(await failure(sendInstructions(cluster, outsider, [forged]))).toMatch(/2006|2001|6001/); // ConstraintSeeds, ConstraintHasOne or NotPublisher
    expect(await fetchPublisher(cluster, publisher.address)).toMatchObject({ versionCount: 2n });
  });

  it('records a revoked entry, and refuses an id that does not match its hash', async () => {
    await sendInstructions(cluster, publisher, [await revokeEntryInstruction(publisher.address, 'tx-v1')]);
    const again = sendInstructions(cluster, publisher, [
      await revokeEntryInstruction(publisher.address, 'tx-v1'),
    ]);
    expect(await failure(again)).not.toBe('');
  });

  it('lets a client detect a truncated log and a rewritten history', async () => {
    const manifest = (n: number, merkleRoot: string, prevRoot: string): Manifest => ({
      manifest_version: 1,
      publisher: publisher.address,
      n,
      merkle_root: merkleRoot,
      prev_root: prevRoot,
      entry_count: 4,
      content_hash: root('cc'),
      uri: 'x',
      published: '2026-09-19',
      revoked: [],
      signature: '00'.repeat(64),
    });
    const full = [manifest(1, root('a1'), GENESIS_ROOT), manifest(2, root('a2'), root('a1'))];
    expect(await compareLogWithChain(cluster, full)).toEqual([]);

    const truncated = await compareLogWithChain(cluster, full.slice(0, 1));
    expect(truncated.map((issue) => issue.hint).join(' ')).toContain('rolled back or truncated');

    const rewritten = await compareLogWithChain(cluster, [
      full[0] as Manifest,
      manifest(2, root('bb'), root('a1')),
    ]);
    expect(rewritten.map((issue) => issue.message).join(' ')).toContain('merkleRoot');

    const unanchored = await compareLogWithChain(cluster, [...full, manifest(3, root('a3'), root('a2'))]);
    expect(unanchored.map((issue) => issue.hint).join(' ')).toContain('never anchored');

    const stranger = await compareLogWithChain(cluster, [
      { ...(full[0] as Manifest), publisher: outsider.address },
    ]);
    expect(stranger.map((issue) => issue.message).join(' ')).toContain('not registered on chain');
  });
});
