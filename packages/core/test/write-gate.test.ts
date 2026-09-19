import { describe, expect, it } from 'vitest';

import { CLUSTER_GENESIS, redactUrl, writeRefusal } from '../src/index.js';

describe('where this tool agrees to write', () => {
  it('writes to devnet, whatever the endpoint is called', () => {
    expect(writeRefusal('https://api.devnet.solana.com', CLUSTER_GENESIS.devnet)).toBeUndefined();
    expect(writeRefusal('https://rpc.example.com/?api-key=abc', CLUSTER_GENESIS.devnet)).toBeUndefined();
  });

  it('writes to a validator on this machine and to no other unknown network', () => {
    const unknown = '9'.repeat(44);
    for (const local of ['http://127.0.0.1:8899', 'http://localhost:8899', 'http://[::1]:8899']) {
      expect(writeRefusal(local, unknown)).toBeUndefined();
    }
    expect(writeRefusal('https://some-svm-chain.example', unknown)).toContain('unknown network');
    expect(writeRefusal('not a url', unknown)).toContain('unknown network');
  });

  it('refuses mainnet and testnet by genesis hash, even behind a local-looking or devnet-looking URL', () => {
    expect(writeRefusal('https://api.devnet.solana.com', CLUSTER_GENESIS['mainnet-beta'])).toContain(
      'is mainnet-beta',
    );
    expect(writeRefusal('http://127.0.0.1:8899', CLUSTER_GENESIS['mainnet-beta'])).toContain(
      'is mainnet-beta',
    );
    expect(writeRefusal('https://api.testnet.solana.com', CLUSTER_GENESIS.testnet)).toContain('is testnet');
  });

  it('never prints an API key', () => {
    const withKey = 'https://mainnet.provider.example/v2/SECRET-PATH-KEY?api-key=SECRET-QUERY-KEY';
    const message = writeRefusal(withKey, CLUSTER_GENESIS['mainnet-beta']) ?? '';
    expect(message).not.toContain('SECRET');
    expect(redactUrl(withKey)).toBe('https://mainnet.provider.example/<redacted>');
    expect(redactUrl('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com');
  });
});
