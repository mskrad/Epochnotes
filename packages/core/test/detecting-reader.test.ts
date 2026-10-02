import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLUSTER_GENESIS, detectingReader, EVM_GENESIS } from '../src/index.js';

/** A JSON-RPC endpoint that answers only the methods it is given; anything else is "method not found". */
async function serve(methods: Record<string, unknown>): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const key = method === 'eth_getBlockByNumber' ? `${method} ${String(params[0])}` : method;
      const answer =
        key in methods
          ? { result: methods[key] }
          : { error: { code: -32601, message: `Method not found: ${method}` } };
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('an endpoint given without a chain', () => {
  const servers: Server[] = [];
  let solana = '';
  let ethereum = '';
  let neither = '';
  beforeAll(async () => {
    const a = await serve({ getGenesisHash: CLUSTER_GENESIS.devnet });
    const b = await serve({
      eth_chainId: '0x1',
      'eth_getBlockByNumber 0x0': { number: '0x0', timestamp: '0x0', hash: EVM_GENESIS['eip155:1'] },
    });
    const c = await serve({});
    servers.push(a.server, b.server, c.server);
    [solana, ethereum, neither] = [a.url, b.url, c.url];
  });
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it('is read as Solana when it answers as Solana', async () => {
    expect(await detectingReader(solana).identify()).toEqual({
      chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      by: 'genesis',
    });
  });

  it('is read as an EVM chain when it answers as one', async () => {
    expect(await detectingReader(ethereum).identify()).toEqual({ chain: 'eip155:1', by: 'genesis' });
  });

  it('is refused, with both reasons, when it answers as neither', async () => {
    await expect(detectingReader(neither).identify()).rejects.toThrow(
      /answers neither as Solana nor as an EVM chain: .*getGenesisHash.*; .*eth_chainId/,
    );
  });
});
