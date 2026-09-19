import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadPublisherKey, publishVersion, readRawLogFrom, verifyEntry } from '../src/index.js';
import { writeTestKey } from './keys.js';

const dir = mkdtempSync(join(tmpdir(), 'epochnotes-remote-'));
const served = join(dir, 'versions');
const entries = join(dir, 'entries');
const keyFile = writeTestKey(join(dir, 'key.json'));
let server: Server;
let base: string;
let publisher: string;
/** What the host does with a request path, so a test can make it misbehave. */
let override: (path: string) => { status: number; body: string } | undefined = () => undefined;

beforeAll(async () => {
  // A static host on loopback with the layout of a versions directory: /1.json, /<root>.jsonl
  server = createServer((request, response) => {
    const path = request.url ?? '/';
    const forced = override(path);
    const file = join(served, path);
    if (forced !== undefined) response.writeHead(forced.status).end(forced.body);
    else if (existsSync(file)) response.end(readFileSync(file));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  publisher = (await loadPublisherKey(keyFile)).address;
  cpSync(new URL('../../../registry/entries', import.meta.url).pathname, entries, { recursive: true });
  const publish = () =>
    publishVersion({
      entriesDir: entries,
      versionsDir: served,
      keyFile,
      uri: `${base}/{root}.jsonl`,
      published: '2026-09-19',
    });
  expect(await publish()).toMatchObject({ ok: true });
  const entry = join(entries, 'tx-v1.yaml');
  writeFileSync(entry, readFileSync(entry, 'utf8').replace('rev: 1\n', 'rev: 2\n'));
  expect(await publish()).toMatchObject({ ok: true, manifest: { n: 2 } });
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const verify = (pin?: { n: number; merkleRoot: string }) =>
  verifyEntry({
    versionsDir: `${base}/`,
    trustedPublishers: [publisher],
    entryId: 'tx-v1',
    ...(pin === undefined ? {} : { pin }),
  });
const messages = (result: { ok: boolean; issues?: { message: string }[] }) =>
  (result.issues ?? []).map((issue) => issue.message).join(' | ');

describe('a version log served over HTTP', () => {
  it('is read to the first 404 and verified like a directory, content included', async () => {
    override = () => undefined;
    expect(await readRawLogFrom(base)).toHaveLength(2);
    const result = await verify();
    expect(result).toMatchObject({ ok: true, versions: 2, proof: { entry: { rev: 2 } } });
    expect(result.ok && result.contentSource).toContain(base);
  });

  it('is not trusted: altered content and an altered manifest are refused', async () => {
    override = (path) =>
      path.endsWith('.jsonl') ? { status: 200, body: 'not the committed content\n' } : undefined;
    expect(messages(await verify())).toContain('No source served the committed content');
    override = (path) =>
      path === '/2.json'
        ? {
            status: 200,
            body: readFileSync(join(served, '2.json'), 'utf8').replace(
              '"entry_count": 4',
              '"entry_count": 9',
            ),
          }
        : undefined;
    expect(messages(await verify())).toContain('Signature does not match');
  });

  it('reports a page served instead of a manifest as a finding', async () => {
    override = (path) => (path === '/2.json' ? { status: 200, body: '<html>welcome</html>' } : undefined);
    const result = await verify();
    expect(result.ok).toBe(false);
  });

  it('cannot tell a host that stops early from a short log, unless the client remembers', async () => {
    const second = JSON.parse(readFileSync(join(served, '2.json'), 'utf8')) as { merkle_root: string };
    override = (path) => (path === '/2.json' ? { status: 404, body: '' } : undefined);
    expect(await verify()).toMatchObject({ ok: true, versions: 1 });
    expect(messages(await verify({ n: 2, merkleRoot: second.merkle_root }))).toContain(
      'version 2 was seen before',
    );
  });

  it('treats a failing host as an error, not as the end of the log', async () => {
    override = (path) => (path === '/2.json' ? { status: 500, body: 'oops' } : undefined);
    await expect(verify()).rejects.toThrow('HTTP 500');
  });
});
