import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { root, run } from './run.js';

let server: Server;
let base: string;
let requests: string[] = [];
let answer: (path: string) => { status: number; body: string } = () => ({ status: 404, body: '' });

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const { status, body } = answer(request.url ?? '');
    response.writeHead(status).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const verify = (versions: string, ...extra: string[]) =>
  run(
    'registry',
    'verify',
    'tx-v1',
    '--versions',
    versions,
    '--publishers',
    `${root}registry/publishers.json`,
    ...extra,
  );

describe('epochnotes registry verify --versions <url>', () => {
  it('exits 2 when the host fails, and 2 when nothing listens there', async () => {
    answer = () => ({ status: 500, body: 'oops' });
    const failing = await verify(base);
    expect(failing.code).toBe(2);
    expect(failing.stderr).toContain('HTTP 500');

    // a port that was open a moment ago and is closed now: a real refused connection
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((resolve) => closed.close(resolve));
    const nobody = await verify(gone);
    expect(nobody.code).toBe(2);
    expect(nobody.stderr).toContain('Cannot verify');
  });

  it('exits 1 on an empty log, which is what a mistyped URL looks like', async () => {
    answer = () => ({ status: 404, body: '' });
    const empty = await verify(`${base}/typo`);
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('The log is empty');
  });

  it('stops at the first thing that is not a manifest instead of following a host that answers 200 to everything', async () => {
    requests = [];
    answer = () => ({ status: 200, body: '<html>welcome</html>' });
    const result = await verify(base, '--json');
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
    expect(requests).toEqual(['/1.json']);
  });

  it('stops just the same when every path answers with JSON that is not a manifest', async () => {
    requests = [];
    answer = () => ({ status: 200, body: '{}' });
    expect((await verify(base)).code).toBe(1);
    expect(requests).toEqual(['/1.json']);
  });

  it('gives up on a manifest that is too large', async () => {
    requests = [];
    answer = () => ({ status: 200, body: `{"padding":"${'x'.repeat(200_000)}"}` });
    expect((await verify(base)).code).toBe(1);
    expect(requests).toEqual(['/1.json']);
  });
});
