import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { contentSourceCandidates, ContentUnavailableError, fetchCommittedContent } from '../src/index.js';

const good = Buffer.from('committed content\n');
const hash = createHash('sha256').update(good).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'epochnotes-content-'));
const goodFile = join(dir, 'good.jsonl');
const badFile = join(dir, 'bad.jsonl');
writeFileSync(goodFile, good);
writeFileSync(badFile, 'something else\n');

let server: Server;
let base: string;
beforeAll(async () => {
  // A loopback server: the fetch path is exercised for real, without leaving the machine.
  server = createServer((request, response) => {
    if (request.url === `/sha256/${hash}.jsonl` || request.url === '/good') response.end(good);
    else if (request.url === '/altered') response.end('altered');
    else if (request.url === '/slow') setTimeout(() => response.end(good), 2_000);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('committed content', () => {
  it('is accepted from a path, a file URL and HTTP when it hashes to the commitment', async () => {
    for (const uri of [goodFile, pathToFileURL(goodFile).href, `${base}/good`]) {
      expect(await fetchCommittedContent({ uri, hash })).toMatchObject({
        source: uri,
        attempts: [{ outcome: 'ok' }],
      });
    }
  });

  it('falls through altered and missing sources to a hash-addressed mirror', async () => {
    const result = await fetchCommittedContent({
      uri: `${base}/altered`,
      hash,
      localFile: badFile,
      mirrors: [`${base}/`],
    });
    expect(result.source).toBe(`${base}/sha256/${hash}.jsonl`);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      'hash_mismatch',
      'hash_mismatch',
      'ok',
    ]);
  });

  it('reports every attempt when no source serves the committed bytes', async () => {
    const failure = await fetchCommittedContent({
      uri: 'ipfs://abc',
      hash,
      localFile: join(dir, 'absent'),
      mirrors: [`${base}/nowhere`],
      timeoutMs: 300,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentUnavailableError);
    expect((failure as ContentUnavailableError).attempts.map((attempt) => attempt.outcome)).toEqual([
      'error',
      'unsupported',
      'http_error',
    ]);
  });

  it('gives up on a source that is too slow or too large', async () => {
    const slow = await fetchCommittedContent({ uri: `${base}/slow`, hash, timeoutMs: 100 }).catch(
      (error: unknown) => error,
    );
    expect((slow as ContentUnavailableError).attempts).toMatchObject([{ outcome: 'timeout' }]);
    const large = await fetchCommittedContent({ uri: goodFile, hash, maxBytes: 4 }).catch(
      (error: unknown) => error,
    );
    expect((large as ContentUnavailableError).attempts).toMatchObject([{ outcome: 'too_large' }]);
  });

  it('lists the committed uri first, then mirrors by hash, without duplicates', async () => {
    expect(contentSourceCandidates('a', hash, ['https://m.example/', 'https://m.example'])).toEqual([
      'a',
      `https://m.example/sha256/${hash}.jsonl`,
    ]);
    await expect(fetchCommittedContent({ uri: 'a', hash: 'nothex' })).rejects.toThrow('32 bytes as hex');
  });
});
