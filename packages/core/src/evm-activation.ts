import type { ActivationReader, ActivationState } from './activation-status.js';
import { call, type JsonRpc } from './json-rpc.js';
import type { Activation } from './schema.js';

/**
 * Genesis block hashes of the EVM chains this library pins. A chain id is only a number an endpoint states; a
 * fork or a test chain can reuse it, and the genesis block cannot. Sources: Ethereum — go-ethereum
 * `params/config.go` `MainnetGenesisHash` at c9a2bc73; Base — ethereum-optimism/superchain-registry
 * `superchain/configs/mainnet/base.toml` `[genesis.l2]` at 5b055be4, the last commit before Base left that
 * registry. Both were read back from the chains themselves on 2026-10-02.
 */
export const EVM_GENESIS: Readonly<Record<string, string>> = {
  'eip155:1': '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
  'eip155:8453': '0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd',
};

interface Block {
  number: bigint;
  timestamp: bigint;
  /** Every field of the block as the endpoint returned it: a fork shows itself by the fields it adds. */
  fields: Record<string, unknown>;
}

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`the endpoint returned ${JSON.stringify(value)} for ${what}, not a hex quantity`);
  return BigInt(value);
}

async function block(rpc: JsonRpc, tag: string): Promise<Block | undefined> {
  const raw = await call(rpc, 'eth_getBlockByNumber', [tag, false]);
  if (raw === null) return undefined;
  if (typeof raw !== 'object' || raw === undefined)
    throw new Error(`eth_getBlockByNumber ${tag} returned ${JSON.stringify(raw)}, not a block`);
  const fields = raw as Record<string, unknown>;
  return {
    number: quantity(fields.number, `the number of block ${tag}`),
    timestamp: quantity(fields.timestamp, `the time of block ${tag}`),
    fields,
  };
}

/** Whether a block carries a header field: a value, not null and not empty. */
const carries = (head: Block, field: string) => {
  const value = head.fields[field];
  return value !== undefined && value !== null && value !== '' && value !== '0x';
};

/**
 * The state of one activation against the head of the chain. A fork by time is a fact the entry states, taken
 * from the client's configuration; where the fork adds a header field, the head block shows whether it is in
 * force, and the two must agree. Nothing here says `absent`: an entry that names a fork time names a fork the
 * chain's clients schedule, so before that time it is `scheduled`.
 */
export function evmActivationState(activation: Activation, head: Block): ActivationState {
  switch (activation.kind) {
    case 'feature-account':
      return { state: 'unknown', reason: 'an EVM chain has no feature accounts' };
    case 'block-height':
      return head.number >= BigInt(activation.at)
        ? { state: 'active', since: { block: String(activation.at) }, confirmedBy: 'height-only' }
        : { state: 'scheduled' };
    case 'timestamp': {
      const reached = head.timestamp >= BigInt(activation.at);
      const field = activation.evidence?.header;
      if (field === undefined)
        return reached
          ? { state: 'active', since: { time: String(activation.at) }, confirmedBy: 'time-only' }
          : { state: 'scheduled' };
      const shown = carries(head, field);
      if (reached && shown)
        return { state: 'active', since: { time: String(activation.at) }, confirmedBy: 'header' };
      if (!reached && !shown) return { state: 'scheduled' };
      return {
        state: 'unknown',
        reason: reached
          ? `the fork time ${activation.at} has passed, but the head block has no ${field}: the chain does not show this fork`
          : `the head block already has ${field}, though the fork time ${activation.at} has not come: the entry and the chain disagree`,
      };
    }
  }
}

/** An EVM chain: the chain id and, where pinned, the genesis block say which chain; the head says the rest. */
export function evmActivationReader(rpc: JsonRpc): ActivationReader {
  return {
    async identify() {
      const chain = `eip155:${quantity(await call(rpc, 'eth_chainId'), 'eth_chainId').toString()}`;
      const pinned = EVM_GENESIS[chain];
      if (pinned === undefined) return { chain, by: 'chain-id' };
      // Only an endpoint that says it has no block 0 — an error, or no block — is read by its chain id: that is
      // what a node that prunes history answers. A block 0 it does return must carry the pinned hash, whatever
      // else is wrong with it, so that an impostor cannot pass by sending a broken one.
      const answer = await rpc('eth_getBlockByNumber', ['0x0', false]);
      if (answer.error !== undefined || answer.result === null || answer.result === undefined)
        return { chain, by: 'chain-id' };
      const hash = (answer.result as { hash?: unknown }).hash;
      if (typeof hash !== 'string' || hash.toLowerCase() !== pinned)
        throw new Error(
          `the endpoint says it serves ${chain}, but its genesis block is ${JSON.stringify(hash)}, not ${pinned}`,
        );
      return { chain, by: 'genesis' };
    },
    async read(activations) {
      const head = await block(rpc, 'latest');
      if (head === undefined) throw new Error('the endpoint has no latest block');
      return {
        point: { block: head.number.toString(), time: head.timestamp.toString() },
        states: activations.map((activation) => evmActivationState(activation, head)),
      };
    },
  };
}
