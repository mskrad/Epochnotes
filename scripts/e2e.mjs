// End-to-end run of the built CLI, the way a user would call it. `npm run e2e` builds first.
// Talks to devnet for the status step; set E2E_OFFLINE=1 to skip that one step.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'packages/cli/bin/epochnotes.js');
const work = mkdtempSync(join(tmpdir(), 'epochnotes-e2e-'));
const versions = join(work, 'versions');
const entries = join(work, 'entries');
const failures = [];
let steps = 0;

function step(name, args, expectedCode, check) {
  steps += 1;
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  let problem = (
    Array.isArray(expectedCode) ? expectedCode.includes(result.status) : result.status === expectedCode
  )
    ? undefined
    : `exit ${result.status}, expected ${expectedCode}`;
  if (problem === undefined && check !== undefined) {
    try {
      problem = check(output, result.stdout);
    } catch (error) {
      problem = String(error);
    }
  }
  console.log(
    `${problem === undefined ? 'ok  ' : 'FAIL'} ${String(steps).padStart(2)}. ${name}${problem === undefined ? '' : ` — ${problem}`}`,
  );
  if (problem !== undefined) failures.push({ name, problem, output: output.slice(0, 800) });
  return output;
}

const has = (text) => (output) => (output.includes(text) ? undefined : `output lacks "${text}"`);

try {
  // a throwaway publisher key in solana-keygen format
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyFile = join(work, 'publisher.json');
  writeFileSync(
    keyFile,
    JSON.stringify([
      ...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
      ...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ]),
  );
  cpSync(join(root, 'registry/entries'), entries, { recursive: true });
  const publishArgs = [
    'registry',
    'publish',
    '--key',
    keyFile,
    '--entries',
    entries,
    '--versions',
    versions,
    '--uri',
    join(versions, '{root}.jsonl'),
  ];

  const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
  step(
    'prints the version of its package.json',
    ['--version'],
    0,
    has(`${version} (entry schema 2; reads 1, 2)`),
  );
  step('validates the registry', ['registry', 'validate', 'registry/entries'], 0, has('tx-v1@'));
  step('dry-run publishes without writing', [...publishArgs, '--dry-run'], 0, () =>
    existsSync(versions) ? 'the versions directory was created' : undefined,
  );
  const published = step('publishes version 1', [...publishArgs, '--json'], 0, (_all, stdout) =>
    JSON.parse(stdout).manifest.n === 1 ? undefined : 'not version 1',
  );
  step('has nothing to publish the second time', publishArgs, 0, has('Nothing to publish'));

  const publisher = JSON.parse(published.slice(published.indexOf('{'))).manifest.publisher;
  const publishers = join(work, 'publishers.json');
  writeFileSync(
    publishers,
    JSON.stringify({ publishers: [{ name: 'e2e', key: publisher, status: 'active' }] }),
  );
  const verifyArgs = ['registry', 'verify', 'tx-v1', '--versions', versions, '--publishers', publishers];
  step('proves an entry against the signed log', verifyArgs, 0, has('is in version 1'));
  step('prints the proof as JSON', [...verifyArgs, '--json'], 0, (_all, stdout) =>
    Array.isArray(JSON.parse(stdout).proof.proof) ? undefined : 'no proof in JSON',
  );
  step(
    'does not trust the repository publisher list for a foreign key',
    ['registry', 'verify', 'tx-v1', '--versions', versions],
    1,
    has('is not trusted'),
  );

  const manifest = join(versions, '1.json');
  const original = readFileSync(manifest, 'utf8');
  const altered = original.replace(/"entry_count": \d+/, '"entry_count": 999');
  // Whatever the number of entries: an edit that changes nothing would let this step pass for nothing.
  if (altered === original) throw new Error('e2e: the manifest edit changed nothing');
  writeFileSync(manifest, altered);
  step('refuses a manifest altered after signing', verifyArgs, 1, has('Signature does not match'));
  writeFileSync(manifest, original);

  const readArgs = ['registry', 'read', 'tx-v1', '--versions', versions, '--publishers', publishers];
  step('reads an entry of the verified version for a consumer', [...readArgs, '--json'], 0, (_all, stdout) =>
    JSON.parse(stdout).provenance.verified === true ? undefined : 'the reading is not marked verified',
  );
  const content = join(
    versions,
    readdirSync(versions).find((name) => name.endsWith('.jsonl')),
  );
  const signedContent = readFileSync(content, 'utf8');
  writeFileSync(content, signedContent.replace('-32015', '-32016'));
  step('gives a consumer nothing from tampered content', [...readArgs, '--json'], 1, (_all, stdout) =>
    stdout.includes('"entries"') ? 'entries were printed from content that failed verification' : undefined,
  );
  writeFileSync(content, signedContent);

  const broken = join(work, 'repo-before');
  const fixed = join(work, 'repo-after');
  for (const [dir, value] of [
    [broken, 0],
    [fixed, 1],
  ]) {
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'reader.ts'),
      `await connection.getTransaction(sig, { maxSupportedTransactionVersion: ${value} });\n`,
    );
  }
  step('finds the break in code before the fix', ['check', 'repo', broken], 1, has('reader.ts:1'));
  step('is silent on code after the fix', ['check', 'repo', fixed], 0, has('0 finding(s)'));
  step(
    'names the entries the repository was never compared against',
    ['check', 'repo', fixed, '--versions', versions, '--publishers', publishers],
    0,
    has('not checked: '),
  );
  step(
    'treats a usage error as 2, not as findings',
    ['registry', 'verify'],
    2,
    has("missing required argument 'entry-id'"),
  );
  step('treats an unreadable path as 2', ['check', 'repo', join(work, 'absent')], 2, has('Cannot check'));

  if (process.env.E2E_OFFLINE === '1')
    console.log(
      'SKIP     status on devnet, the Solana watcher and rent scan on mainnet (E2E_OFFLINE=1): this run does not cover the network steps',
    );
  else {
    step(
      'reads the state of every activation on devnet, named by its CAIP-2 id, as JSON',
      ['status', '--chain', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', '--json'],
      0,
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        if (
          report.chain !== 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' ||
          report.name !== 'devnet' ||
          report.identifiedBy !== 'genesis'
        )
          return 'the report does not name the chain';
        if (!/^\d+$/.test(report.point?.slot ?? '')) return 'no slot in the report';
        return report.activations.length >= 11 &&
          report.activations.every((item) => item.activation.address && item.status?.state)
          ? undefined
          : 'activations are missing a state';
      },
    );
    step(
      'reads a change of Ethereum and Base on Base itself: a fork time confirmed by the header of the head block',
      ['status', '--chain', 'base', '--json'],
      0,
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        if (report.chain !== 'eip155:8453' || !/^\d+$/.test(report.point?.block ?? ''))
          return 'the report does not name Base and its head block';
        const fork = report.activations.find((item) => item.entry === 'eip-7702');
        if (fork?.status?.state !== 'active' || fork.status.confirmedBy !== 'header')
          return `eip-7702 is not active by header on Base: ${JSON.stringify(fork?.status)}`;
        return report.withoutActivation.some((item) => item.entry === 'tx-v1')
          ? undefined
          : 'the Solana entries are not named as having no activation on Base';
      },
    );
    step(
      'asks a Base provider, read-only, whether it returns a set-code transaction whole',
      [
        'check',
        'rpc',
        '--rpc-url',
        'https://mainnet.base.org',
        '--versions',
        versions,
        '--publishers',
        publishers,
        '--json',
      ],
      0,
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        const probe = report.probes.find(
          (item) => item.rule === 'base-provider-returns-set-code-transaction',
        );
        if (report.chain !== 'eip155:8453') return `the endpoint was not identified as Base: ${report.chain}`;
        return probe?.verdict === 'reads'
          ? undefined
          : `the Base probe says ${probe?.verdict}: ${probe?.explanation}`;
      },
    );
    step(
      // The probe of the entry is pinned to a mainnet-beta transaction: against devnet nothing can be observed,
      // and the run must not pass for a checked endpoint.
      'refuses to pass an endpoint no probe could speak about',
      [
        ...['check', 'rpc', '--rpc-url', 'https://api.devnet.solana.com'],
        ...['--versions', versions, '--publishers', publishers, '--json'],
      ],
      2,
      (_all, stdout) => (JSON.parse(stdout).observed === 0 ? undefined : 'a probe observed the endpoint'),
    );
    step(
      'plans the close of a real OpenBook v2 account on mainnet and asks the cluster what it would do, sending nothing',
      ['rent', 'close', '--account', '12uqkw7gJ4JAMQqKHQxMiF187Xj1taEUBb6icoiacYgG', '--json'],
      // The account belongs to somebody else and may fill up or disappear: both outcomes of the simulation are
      // accepted, as long as the program itself was reached and answered.
      [0, 1],
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        if (report.ok === false)
          return /no such account/.test(JSON.stringify(report))
            ? undefined
            : 'refused for another reason than a missing account';
        if (typeof report.transaction !== 'string' || report.owner !== report.destination)
          return 'no unsigned transaction for the owner';
        return report.simulation.logs.some((line) => line.includes('Instruction: CloseOpenOrdersAccount'))
          ? undefined
          : 'the simulation did not reach the close instruction';
      },
    );
    const watched = join(work, 'watch');
    const watchArgs = ['watch', 'solana', '--state', join(watched, 'state.json'), '--out', watched, '--json'];
    step('takes a baseline of every gate agave declares on three clusters', watchArgs, 0, (_all, stdout) => {
      const report = JSON.parse(stdout);
      if (report.baseline !== true) return 'the first run is not a baseline';
      if (!/^[0-9a-f]{40}$/.test(report.agave?.commit ?? '')) return 'the agave commit is not pinned';
      if (report.declared < 200 || report.inRegistry < 1)
        return `${report.declared} gates, ${report.inRegistry} named`;
      return report.upcoming.length > 0 ? undefined : 'nothing on the way to mainnet-beta';
    });
    // The second run reads the same agave commit: a new commit there between two runs is not this test's business.
    const agaveRef = JSON.parse(readFileSync(join(watched, 'state.json'), 'utf8')).agave.commit;
    step(
      'compares the second run with the first and drafts nothing on a quiet chain',
      [...watchArgs, '--agave-ref', agaveRef],
      0,
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        if (report.baseline !== false) return 'the second run did not compare with the snapshot';
        return report.newlyDeclared.length === 0 && report.drafts.length === 0
          ? undefined
          : 'a quiet chain produced changes';
      },
    );
    step(
      'measures rent held above the minimum by a program on mainnet, from the verified version',
      [
        ...['rent', 'scan', '--program', 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb'],
        ...['--versions', versions, '--publishers', publishers, '--json'],
      ],
      0,
      (_all, stdout) => {
        const report = JSON.parse(stdout);
        if (report.provenance?.verified !== true) return 'the schedule did not come from a verified version';
        if (!/^\d+$/.test(report.slot) || !/^\d+$/.test(report.currentRate))
          return 'no slot or rate in the report';
        const closable = new Set(report.buckets.map((bucket) => bucket.closableBy));
        if (!closable.has('owner') || !closable.has('admin'))
          return 'account types are not split by who can close them';
        const sum = report.buckets.reduce((total, bucket) => total + BigInt(bucket.excessNow), 0n);
        return sum === BigInt(report.total.excessNow) && report.total.accounts > 1000
          ? undefined
          : 'the buckets do not add up to the total';
      },
    );
  }
} catch (error) {
  failures.push({ name: 'the scenario itself', problem: String(error), output: '' });
} finally {
  // the scratch directory holds a private key, throwaway or not
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${steps - failures.length} of ${steps} steps passed.`);
for (const failure of failures) console.log(`\n--- ${failure.name}: ${failure.problem}\n${failure.output}`);
process.exit(failures.length === 0 ? 0 : 1);
