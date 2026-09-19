import type { Address } from '@solana/kit';

import {
  type Cluster,
  compareLogWithChain,
  configAddress,
  fetchPublisher,
  initializeInstruction,
  loadSigner,
  publisherAddress,
  publishVersionInstruction,
  registerPublisherInstruction,
  sendInstructions,
  versionAddress,
  versionArgsOf,
} from './onchain.js';
import type { Issue } from './validate.js';
import { readRawLog } from './version-store.js';
import { verifyLog } from './version.js';

export interface AnchoredVersion {
  n: number;
  merkleRoot: string;
  address: Address;
  signature: string;
}

export type AnchorResult =
  | { ok: true; publisher: Address; anchored: AnchoredVersion[]; alreadyOnChain: number }
  | { ok: false; issues: Issue[] };

/**
 * Writes to chain every version of the local log that is not there yet, oldest first. The log is
 * verified before anything is sent, and the program itself refuses a version that does not continue
 * the chain, so a partly anchored log can simply be anchored again.
 */
export async function anchorLog(options: {
  versionsDir: string;
  keyFile: string;
  cluster: Cluster;
}): Promise<AnchorResult> {
  const signer = await loadSigner(options.keyFile);
  const log = await verifyLog(readRawLog(options.versionsDir), [signer.address]);
  if (!log.ok) return log;
  const onchain = await fetchPublisher(options.cluster, signer.address);
  if (onchain === undefined) {
    const hint =
      'The registry admin has to admit this key first: `epochnotes registry admit --publisher <address> --name <name>`.';
    return {
      ok: false,
      issues: [{ path: 'chain', message: `Publisher ${signer.address} is not registered on chain`, hint }],
    };
  }
  const known = log.manifests.slice(0, Number(onchain.versionCount));
  // Nothing on chain yet means nothing to disagree with; comparing an empty log would only say "empty".
  const disagreement = known.length === 0 ? [] : await compareLogWithChain(options.cluster, known);
  if (known.length < Number(onchain.versionCount) || disagreement.length > 0) {
    const issues =
      disagreement.length > 0
        ? disagreement
        : [
            {
              path: 'chain',
              message: `The chain has ${onchain.versionCount} version(s), the log has ${log.manifests.length}`,
              hint: 'The local log is behind the chain; fetch the full log before publishing.',
            },
          ];
    return { ok: false, issues };
  }
  const anchored: AnchoredVersion[] = [];
  for (const manifest of log.manifests.slice(known.length)) {
    const instruction = await publishVersionInstruction(
      signer.address,
      versionArgsOf(manifest),
      options.cluster.programId,
    );
    const signature = await sendInstructions(options.cluster, signer, [instruction]);
    anchored.push({
      n: manifest.n,
      merkleRoot: manifest.merkle_root,
      address: await versionAddress(signer.address, BigInt(manifest.n), options.cluster.programId),
      signature,
    });
  }
  return {
    ok: true,
    publisher: await publisherAddress(signer.address, options.cluster.programId),
    anchored,
    alreadyOnChain: known.length,
  };
}

export interface AdmitResult {
  config: Address;
  publisher: Address;
  initialized: boolean;
  signatures: string[];
}

/** Admits a publisher key, creating the registry first if this admin is the one to create it. */
export async function admitPublisher(options: {
  adminKeyFile: string;
  publisher: string;
  name: string;
  cluster: Cluster;
}): Promise<AdmitResult> {
  const admin = await loadSigner(options.adminKeyFile);
  const config = await configAddress(options.cluster.programId);
  const signatures: string[] = [];
  const { createSolanaRpc } = await import('@solana/kit');
  const existing = await createSolanaRpc(options.cluster.rpcUrl)
    .getAccountInfo(config, { encoding: 'base64' })
    .send();
  const initialized = existing.value === null;
  if (initialized)
    signatures.push(
      await sendInstructions(options.cluster, admin, [
        await initializeInstruction(admin.address, options.cluster.programId),
      ]),
    );
  signatures.push(
    await sendInstructions(options.cluster, admin, [
      await registerPublisherInstruction(
        admin.address,
        options.publisher,
        options.name,
        options.cluster.programId,
      ),
    ]),
  );
  return {
    config,
    publisher: await publisherAddress(options.publisher, options.cluster.programId),
    initialized,
    signatures,
  };
}
