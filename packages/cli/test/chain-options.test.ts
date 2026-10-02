import { SOLANA_CHAINS } from '@epochnotes/core';
import { describe, expect, it } from 'vitest';

import { chainFromOptions, resolveChain, UsageError } from '../src/cluster.js';

describe('which chain a command reads', () => {
  it('turns every cluster name into its CAIP-2 id and its public endpoint', () => {
    for (const cluster of ['mainnet-beta', 'testnet', 'devnet'] as const)
      expect(resolveChain(cluster)).toEqual({
        chain: SOLANA_CHAINS[cluster],
        rpcUrl: `https://api.${cluster}.solana.com`,
      });
    // A local validator has no fixed id: the endpoint is asked.
    expect(resolveChain('localnet')).toEqual({ rpcUrl: 'http://127.0.0.1:8899' });
  });

  it('keeps the chain asked for when the endpoint is given, so that a mismatch is refused, not read', () => {
    expect(resolveChain('mainnet-beta', 'https://api.devnet.solana.com')).toEqual({
      chain: SOLANA_CHAINS['mainnet-beta'],
      rpcUrl: 'https://api.devnet.solana.com',
    });
  });

  it('reads an endpoint given alone as the chain it says it serves, and mainnet-beta when nothing is given', () => {
    expect(chainFromOptions({ rpcUrl: 'https://rpc.example' })).toEqual({ rpcUrl: 'https://rpc.example' });
    expect(chainFromOptions({})).toEqual(resolveChain('mainnet-beta'));
  });

  it('refuses --chain and --cluster that name different chains, and accepts them when they agree', () => {
    expect(() => chainFromOptions({ chain: 'devnet', cluster: 'mainnet-beta' })).toThrow(UsageError);
    expect(() => chainFromOptions({ chain: 'localnet', cluster: 'localnet' })).toThrow(UsageError);
    expect(chainFromOptions({ chain: SOLANA_CHAINS.devnet, cluster: 'devnet' })).toEqual(
      resolveChain('devnet'),
    );
  });

  it('refuses a name that is not a chain, and a Solana chain it knows no endpoint for', () => {
    for (const name of ['bitcoin', 'eip155:', 'EIP155:1', 'eip155:1:2', ''])
      expect(() => resolveChain(name), name).toThrow(UsageError);
    expect(() => resolveChain('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCk000')).toThrow(/pass one with --rpc-url/);
    expect(() => resolveChain('eip155:10')).toThrow(/no public endpoint is known for eip155:10/);
    expect(resolveChain('ethereum')).toMatchObject({ chain: 'eip155:1' });
    expect(resolveChain('base')).toMatchObject({ chain: 'eip155:8453' });
    expect(resolveChain('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCk000', 'http://127.0.0.1:8899')).toEqual({
      chain: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCk000',
      rpcUrl: 'http://127.0.0.1:8899',
    });
  });
});
