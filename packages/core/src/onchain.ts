/*
 * Client of the on-chain registry program (programs/registry), written against @solana/kit.
 * The program is small, so instructions and accounts are encoded here by hand rather than generated;
 * a test keeps the discriminators and layouts in step with the program's IDL.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  AccountRole,
  addCodecSizePrefix,
  type Address,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fixCodecSize,
  getAddressCodec,
  getAddressEncoder,
  getBooleanCodec,
  getBytesCodec,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getStructCodec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
  getUtf8Codec,
  type Instruction,
  type KeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import type { Issue } from './validate.js';
import { GENESIS_ROOT, type Manifest } from './version.js';

export const REGISTRY_PROGRAM_ID: Address = address('Diad4BcYWeB3Epgma7RZFNWspm5gpdtTLnwoj3UWEcdy');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

/** Anchor discriminators: the first 8 bytes of sha256 over `global:<instruction>` or `account:<Type>`. */
export function discriminator(namespace: 'global' | 'account', name: string): Uint8Array {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
}

const hash32 = fixCodecSize(getBytesCodec(), 32);
const text = addCodecSizePrefix(getUtf8Codec(), getU32Codec());
const hex = (bytes: Uint8Array | ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString('hex');
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));

const publisherCodec = getStructCodec([
  ['authority', getAddressCodec()],
  ['name', text],
  ['active', getBooleanCodec()],
  ['admittedBy', getAddressCodec()],
  ['versionCount', getU64Codec()],
  ['latestRoot', hash32],
  ['bump', getU8Codec()],
]);

const versionCodec = getStructCodec([
  ['publisher', getAddressCodec()],
  ['n', getU64Codec()],
  ['merkleRoot', hash32],
  ['prevRoot', hash32],
  ['contentHash', hash32],
  ['entryCount', getU32Codec()],
  ['uri', text],
  ['slot', getU64Codec()],
  ['bump', getU8Codec()],
]);

const versionArgsCodec = getStructCodec([
  ['merkleRoot', hash32],
  ['prevRoot', hash32],
  ['contentHash', hash32],
  ['entryCount', getU32Codec()],
  ['uri', text],
]);

export interface OnchainPublisher {
  address: Address;
  authority: string;
  name: string;
  active: boolean;
  admittedBy: string;
  versionCount: bigint;
  latestRoot: string;
}

export interface OnchainVersion {
  address: Address;
  publisher: string;
  n: bigint;
  merkleRoot: string;
  prevRoot: string;
  contentHash: string;
  entryCount: number;
  uri: string;
  slot: bigint;
}

const seed = (value: string) => new TextEncoder().encode(value);
const u64le = (value: bigint) => Uint8Array.from(getU64Codec().encode(value));

export async function configAddress(programId = REGISTRY_PROGRAM_ID): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: programId, seeds: [seed('config')] }))[0];
}

export async function publisherAddress(authority: string, programId = REGISTRY_PROGRAM_ID): Promise<Address> {
  const seeds = [seed('publisher'), getAddressEncoder().encode(address(authority))];
  return (await getProgramDerivedAddress({ programAddress: programId, seeds }))[0];
}

export async function versionAddress(
  authority: string,
  n: bigint,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Address> {
  const seeds = [seed('version'), getAddressEncoder().encode(address(authority)), u64le(n)];
  return (await getProgramDerivedAddress({ programAddress: programId, seeds }))[0];
}

export async function revocationAddress(
  authority: string,
  entryId: string,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Address> {
  const idHash = createHash('sha256').update(entryId).digest();
  const seeds = [seed('revoked'), getAddressEncoder().encode(address(authority)), idHash];
  return (await getProgramDerivedAddress({ programAddress: programId, seeds }))[0];
}

function decodeAccount<T>(
  name: string,
  data: Uint8Array,
  codec: { decode(bytes: Uint8Array, offset?: number): T },
): T {
  if (hex(data.subarray(0, 8)) !== hex(discriminator('account', name)))
    throw new Error(`Account is not a ${name}`);
  return codec.decode(data, 8);
}

export function decodePublisher(at: Address, data: Uint8Array): OnchainPublisher {
  const raw = decodeAccount('Publisher', data, publisherCodec);
  return {
    address: at,
    authority: raw.authority,
    name: raw.name,
    active: raw.active,
    admittedBy: raw.admittedBy,
    versionCount: raw.versionCount,
    latestRoot: hex(raw.latestRoot),
  };
}

export function decodeVersion(at: Address, data: Uint8Array): OnchainVersion {
  const raw = decodeAccount('RegistryVersion', data, versionCodec);
  return {
    address: at,
    publisher: raw.publisher,
    n: raw.n,
    merkleRoot: hex(raw.merkleRoot),
    prevRoot: hex(raw.prevRoot),
    contentHash: hex(raw.contentHash),
    entryCount: raw.entryCount,
    uri: raw.uri,
    slot: raw.slot,
  };
}

function instruction(
  programId: Address,
  name: string,
  args: Uint8Array[],
  accounts: Instruction['accounts'],
): Instruction {
  const data = Buffer.concat([discriminator('global', name), ...args]);
  return { programAddress: programId, accounts, data: Uint8Array.from(data) } as Instruction;
}

const writableSigner = (at: Address) => ({ address: at, role: AccountRole.WRITABLE_SIGNER });
const writable = (at: Address) => ({ address: at, role: AccountRole.WRITABLE });
const readonly = (at: Address) => ({ address: at, role: AccountRole.READONLY });

export async function initializeInstruction(
  admin: Address,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Instruction> {
  return instruction(
    programId,
    'initialize',
    [],
    [writable(await configAddress(programId)), writableSigner(admin), readonly(SYSTEM_PROGRAM)],
  );
}

export async function registerPublisherInstruction(
  admin: Address,
  authority: string,
  name: string,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Instruction> {
  const args = [
    Uint8Array.from(getAddressEncoder().encode(address(authority))),
    Uint8Array.from(text.encode(name)),
  ];
  const accounts = [
    readonly(await configAddress(programId)),
    writable(await publisherAddress(authority, programId)),
    writableSigner(admin),
    readonly(SYSTEM_PROGRAM),
  ];
  return instruction(programId, 'register_publisher', args, accounts);
}

export interface VersionArgs {
  n: bigint;
  merkleRoot: string;
  prevRoot: string;
  contentHash: string;
  entryCount: number;
  uri: string;
}

export const versionArgsOf = (manifest: Manifest): VersionArgs => ({
  n: BigInt(manifest.n),
  merkleRoot: manifest.merkle_root,
  prevRoot: manifest.prev_root,
  contentHash: manifest.content_hash,
  entryCount: manifest.entry_count,
  uri: manifest.uri,
});

export async function publishVersionInstruction(
  authority: Address,
  version: VersionArgs,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Instruction> {
  const encoded = versionArgsCodec.encode({
    merkleRoot: unhex(version.merkleRoot),
    prevRoot: unhex(version.prevRoot),
    contentHash: unhex(version.contentHash),
    entryCount: version.entryCount,
    uri: version.uri,
  });
  const accounts = [
    writable(await publisherAddress(authority, programId)),
    writable(await versionAddress(authority, version.n, programId)),
    writableSigner(authority),
    readonly(SYSTEM_PROGRAM),
  ];
  return instruction(programId, 'publish_version', [u64le(version.n), Uint8Array.from(encoded)], accounts);
}

export async function setPublisherActiveInstruction(
  admin: Address,
  authority: string,
  active: boolean,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Instruction> {
  const accounts = [
    readonly(await configAddress(programId)),
    writable(await publisherAddress(authority, programId)),
    { address: admin, role: AccountRole.READONLY_SIGNER },
  ];
  return instruction(
    programId,
    'set_publisher_active',
    [Uint8Array.from(getBooleanCodec().encode(active))],
    accounts,
  );
}

export async function revokeEntryInstruction(
  authority: Address,
  entryId: string,
  programId = REGISTRY_PROGRAM_ID,
): Promise<Instruction> {
  const idHash = createHash('sha256').update(entryId).digest();
  const accounts = [
    readonly(await publisherAddress(authority, programId)),
    writable(await revocationAddress(authority, entryId, programId)),
    writableSigner(authority),
    readonly(SYSTEM_PROGRAM),
  ];
  return instruction(
    programId,
    'revoke_entry',
    [Uint8Array.from(idHash), Uint8Array.from(text.encode(entryId))],
    accounts,
  );
}

export interface Cluster {
  rpcUrl: string;
  wsUrl: string;
  programId?: Address;
}

export async function loadSigner(keyFile: string): Promise<KeyPairSigner> {
  try {
    return await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(keyFile, 'utf8')) as number[]),
    );
  } catch {
    throw new Error(`${keyFile} is not a keypair in solana-keygen format (a JSON array of 64 bytes)`);
  }
}

/** Signs and sends the instructions, waits for confirmation and returns the transaction signature. */
export async function sendInstructions(
  cluster: Cluster,
  payer: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
  const rpc = createSolanaRpc(cluster.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(cluster.wsUrl);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(transaction, { commitment: 'confirmed' });
  return getSignatureFromTransaction(transaction);
}

async function fetchAccount(cluster: Cluster, at: Address): Promise<Uint8Array | undefined> {
  const { value } = await createSolanaRpc(cluster.rpcUrl)
    .getAccountInfo(at, { encoding: 'base64', commitment: 'confirmed' })
    .send();
  return value === null ? undefined : Uint8Array.from(Buffer.from(value.data[0], 'base64'));
}

export async function fetchPublisher(
  cluster: Cluster,
  authority: string,
): Promise<OnchainPublisher | undefined> {
  const at = await publisherAddress(authority, cluster.programId);
  const data = await fetchAccount(cluster, at);
  return data === undefined ? undefined : decodePublisher(at, data);
}

export async function fetchVersion(
  cluster: Cluster,
  authority: string,
  n: bigint,
): Promise<OnchainVersion | undefined> {
  const at = await versionAddress(authority, n, cluster.programId);
  const data = await fetchAccount(cluster, at);
  return data === undefined ? undefined : decodeVersion(at, data);
}

/** Solana mainnet-beta, by genesis hash: the name a user passes says nothing about where an endpoint leads. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/** Throws unless the endpoint is something other than mainnet. Writing there is a decision for the project owner. */
export async function assertNotMainnet(cluster: Cluster): Promise<void> {
  const genesis = await createSolanaRpc(cluster.rpcUrl).getGenesisHash().send();
  if (genesis === MAINNET_GENESIS_HASH) {
    throw new Error(
      `${cluster.rpcUrl} is mainnet-beta (genesis ${genesis}); this tool writes to devnet and localnet only`,
    );
  }
}

export interface OnchainRevocation {
  address: Address;
  entryId: string;
  atVersion: bigint;
}

const revocationCodec = getStructCodec([
  ['publisher', getAddressCodec()],
  ['entryId', text],
  ['atVersion', getU64Codec()],
  ['slot', getU64Codec()],
  ['bump', getU8Codec()],
]);

/** The on-chain record that a publisher withdrew an entry, if there is one. */
export async function fetchRevocation(
  cluster: Cluster,
  authority: string,
  entryId: string,
): Promise<OnchainRevocation | undefined> {
  const at = await revocationAddress(authority, entryId, cluster.programId);
  const data = await fetchAccount(cluster, at);
  if (data === undefined) return undefined;
  const raw = decodeAccount('Revocation', data, revocationCodec);
  return { address: at, entryId: raw.entryId, atVersion: raw.atVersion };
}

/**
 * Compares an off-chain log with the chain. The chain cannot be truncated or forked, so this is what
 * catches a server that serves only the first versions, or a publisher that signed two histories:
 * the number of versions, and every root, hash and count, must agree.
 */
export async function compareLogWithChain(cluster: Cluster, log: Manifest[]): Promise<Issue[]> {
  const authority = log[0]?.publisher;
  if (authority === undefined)
    return [{ path: 'log', message: 'The log is empty', hint: 'Nothing to compare with the chain.' }];
  const publisher = await fetchPublisher(cluster, authority);
  if (publisher === undefined)
    return [
      {
        path: 'chain',
        message: `Publisher ${authority} is not registered on chain`,
        hint: 'Check the cluster and the program id; the publisher must be admitted by the registry admin.',
      },
    ];
  const issues: Issue[] = [];
  if (!publisher.active) {
    // A suspended publisher cannot publish, so everything on chain predates the suspension. But the admin
    // suspends a key after something went wrong, and the chain does not say since when it was unsafe: fail closed.
    issues.push({
      path: 'chain',
      message: `Publisher ${publisher.name} is suspended by the registry admin`,
      hint: 'The admin no longer vouches for this key. Ask the publisher or the admin which versions are still good.',
    });
  }
  if (publisher.versionCount !== BigInt(log.length)) {
    const hint =
      publisher.versionCount > BigInt(log.length)
        ? 'The log was rolled back or truncated: newer versions exist on chain. Fetch the full log.'
        : 'The log has versions that were never anchored; do not trust them until they are.';
    issues.push({
      path: 'chain',
      message: `The chain has ${publisher.versionCount} version(s), the log has ${log.length}`,
      hint,
    });
  }
  for (const manifest of log.slice(0, Number(publisher.versionCount))) {
    const onchain = await fetchVersion(cluster, authority, BigInt(manifest.n));
    const at = `version ${manifest.n}`;
    if (onchain === undefined) {
      issues.push({ path: at, message: 'No such version on chain', hint: 'The version was never anchored.' });
      continue;
    }
    const expected = versionArgsOf(manifest);
    const differs = (['merkleRoot', 'prevRoot', 'contentHash', 'entryCount'] as const).filter(
      (field) => String(onchain[field]) !== String(expected[field]),
    );
    if (differs.length > 0)
      issues.push({
        path: at,
        message: `Differs from the chain in: ${differs.join(', ')}`,
        hint: 'The history was rewritten; the chain is the reference.',
      });
  }
  return issues;
}

export { GENESIS_ROOT };
